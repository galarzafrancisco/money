# Deployment

Money runs on the DGX Spark k3d cluster (`prod-cluster`) through the same flow
as Taico: **Money CI → spark-ops PR → hydration and auto-merge → Argo CD**.
Public URL: **https://money.american-broomstick.com**.

Data lives in a **dedicated PostgreSQL 16** on the Spark host
(`money-postgres`, outside k3d and separate from Taico's database), provisioned
and operated by spark-ops. Pod restarts and redeploys keep every record. See
[Database](#database).

## How a change reaches the cluster

1. A merge to `main` runs `.github/workflows/ci.yml` ([ci.md](ci.md)). `publish`
   pushes `ghcr.io/galarzafrancisco/money:main-<sha7>`.
2. `deploy` copies `install/manifests/` to `spark-ops/k8s/money/`, pins the image
   with `kustomize edit set image ghcr.io/galarzafrancisco/money=…:main-<sha7>`
   in `base/kustomization.yaml`, and opens `deploy/money-<sha7>` in spark-ops.
3. spark-ops `hydrate-and-merge` writes its shared `env.env` into every
   `k8s/*/overlays/main/` and squash-merges the PR (drafts are not merged).
4. The `production-apps` ApplicationSet turns `k8s/money/overlays/main` into
   the Argo CD app `money-prod`, syncing into namespace `money` (from the
   directory name) with prune and self-heal.

So **a merge to `main` that touches the app or `install/manifests` deploys
right away**, including any new migration, which runs against the production
database on startup. The `manifests`
CI job renders the overlay on every PR, the same way `deploy` does.

## Manifests

```
install/manifests/
├── base/
│   ├── kustomization.yaml   namespace money; images: ghcr.io/galarzafrancisco/money (CI pins newTag)
│   ├── namespace.yaml       sync-wave -2
│   ├── configmap.yaml       money-config: all non-secret settings (DATABASE_MODE=postgres)
│   ├── deployment.yaml      1 replica, RollingUpdate, probes on /health, hardened pod,
│   │                        DATABASE_URL from Secret money-database
│   ├── service.yaml         ClusterIP :80 → 4180
│   ├── certificate.yaml     cert-manager, letsencrypt-cluster-issuer → money-tls
│   ├── listener-set.yaml    HTTPS :443 listener on Gateway gateways/public
│   ├── route.yaml           whole host → money service
│   └── https-redirect.yaml  HTTP → HTTPS 301 on the gateway's http listener
└── overlays/main/
    └── kustomization.yaml   resources: ../../base
```

They follow ai-monorepo's `install/manifests` layout. The routing and TLS
follow `spark-ops/k8s/address-australia`, the existing
`*.american-broomstick.com` app. What differs from Taico, and why:

- **The hostname is set in the base, not hydrated.** spark-ops hydration writes
  one shared `env.env` (`DOMAIN`, `ISSUER_URL`, `SPARK_IP`, …) whose values are
  Taico's. Money's settings aren't secret, so they live in `configmap.yaml`.
  The overlay reads `env.env` only for `SPARK_IP`, which it writes into the
  database EndpointSlice (same as Taico's `taico-postgres-host`).
- **The database Service and EndpointSlice are in the manifests.**
  `base/postgres-service.yaml` defines `Service/money-postgres` (5432) and
  `EndpointSlice/money-postgres-host` (`SPARK_IP`:15434, the host container),
  so Argo CD manages them like Taico's. No volume. `Secret/money-database` is
  the exception: it holds the credentials, which spark-ops generates and keeps
  on the host, so it is not in Git and CI rejects it here.
- **The image serves the web app** at `/` from the same origin as `/api` and
  `/auth` (the Dockerfile copies `apps/web/dist`), so the cookie session works
  without CORS or a separate frontend deployment. CI's smoke test checks that
  `/accounts` returns the app.
- **Probes use `/health`**, which runs `SELECT 1`. A Postgres outage makes the
  pod unready; the lenient liveness probe restarts it only after about two
  minutes, so a short database restart doesn't.
- **One replica, `RollingUpdate` (`maxSurge: 1`, `maxUnavailable: 0`).** A deploy
  starts the new pod and stops the old one only once the new one is ready, so
  there is no downtime. The two pods overlap briefly on the same database. The
  new pod runs pending migrations on startup while the old pod is still serving,
  so a migration must stay compatible with the previous release (add before you
  remove or rename; split a breaking change across two deploys). TypeORM takes no
  advisory lock, so don't scale above one replica.
- **The pod is hardened**: it runs as non-root with a read-only root
  filesystem, no capabilities and a 64Mi `/tmp`. CI smoke-tests the image
  with the same restrictions.
- **The user is numeric.** The container sets `runAsUser: 1000` and
  `runAsGroup: 1000`, and the image declares `USER 1000:1000` (the
  `node` user of `node:24-alpine`). The kubelet enforces `runAsNonRoot` only
  against a numeric UID: with `USER node` and no `runAsUser`, the pod fails
  with `CreateContainerConfigError` ("image has non-numeric user"). This
  follows the hardened workloads in spark-ops (observability). Taico's own
  manifests set no security context, so they are not a model here. CI checks
  both the image and the rendered manifests.

### Validating locally

```bash
kubectl kustomize install/manifests/overlays/main            # render
# or exactly as CI does, on a copy:
cp -r install/manifests /tmp/money && (cd /tmp/money/base && \
  kustomize edit set image ghcr.io/galarzafrancisco/money=ghcr.io/galarzafrancisco/money:main-0000000) && \
  kustomize build /tmp/money/overlays/main
# security context check (numeric non-root user and hardening):
kubectl kustomize install/manifests/overlays/main > /tmp/money.yaml && \
  node scripts/check-manifest-security.mjs /tmp/money.yaml
# database check (postgres mode, DATABASE_URL only from Secret money-database):
node scripts/check-manifest-database.mjs /tmp/money.yaml
```

A rendered manifest is not a deployment. Check a live rollout with
`kubectl -n money get pods`, the Argo CD app `money-prod`, and
`curl https://money.american-broomstick.com/health`.

## Configuration

`money-config` (ConfigMap). The image sets `NODE_ENV=production` and `PORT=4180`.

| Variable | Value | Notes |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://money.american-broomstick.com` | Token audiences are `$PUBLIC_BASE_URL/mcp` and `/api`. The resource metadata and the browser sign-in callback are built from it too |
| `TAICO_ISSUER` | `https://taico.app` | Required in production. JWKS is `https://taico.app/.well-known/jwks.json` |
| `TAICO_AUTHORIZATION_SERVERS` | `https://taico.app/mcp/money/0.0.0` | Advertised in protected-resource metadata: the authorization server of Taico's `money` MCP server entry |
| `DATABASE_MODE` | `postgres` | Explicit, so a missing `DATABASE_URL` fails startup. See below |
| `DATABASE_SSL` | `false` | The connection stays on the Spark host; spark-ops serves it without TLS |
| `MARKET_PRICE_PROVIDER` | `mock` | Deterministic, labelled mock prices. `yahoo` is the unofficial, keyless opt-in |

Browser sign-in ([web-auth.md](../apps/backend/docs/web-auth.md)) uses its
defaults, so it needs no ConfigMap entries: `TAICO_WEB_SERVER_ID=money-api`,
authorization server `https://taico.app/mcp/money-api/0.0.0`, client_id
`https://money.american-broomstick.com/auth/client-metadata.json`, callback
`/auth/callback`, `WEB_APP_URL=$PUBLIC_BASE_URL`, and `__Host-` Secure cookies
(because the base URL is https). Sessions are stored in the database, so they
survive restarts and redeploys.

The valuation job runs hourly in the pod (`VALUATION_*` defaults). Its database
lease and `valuations:run` are described in
[apps/backend/docs/valuations.md](../apps/backend/docs/valuations.md).
`valuations:run` works against the deployed database (for example from
`kubectl -n money exec deploy/money -- node dist/valuations/run-job.js`, see
that guide); the lease keeps it from overlapping the in-pod job.

### `DATABASE_MODE`

| Mode | Database | Production |
|---|---|---|
| unset | Postgres when `DATABASE_URL` is set, otherwise on-disk PGlite | needs `DATABASE_URL` |
| `postgres` | `DATABASE_URL` (required) | yes, and it is the only durable option |
| `memory` | in-memory PGlite, empty on every start | allowed, but **non-durable**; no longer deployed |
| `pglite` | on-disk PGlite at `PGLITE_DATA_DIR` | refused |

Production never falls back to an embedded database on its own. Without
`DATABASE_URL`, it starts only when `DATABASE_MODE=memory` is set, and it logs
a `NOT DURABLE` warning at startup. Setting both `memory` and `DATABASE_URL`
fails, so the database in use is never ambiguous.

Memory mode serves PGlite over the Postgres wire protocol on `127.0.0.1` and
connects through the normal `pg` driver with **one** pooled connection, which
is what the PGlite test suite does too. It doesn't use the in-process
`typeorm-pglite` driver: that driver shares one PGlite session across all
TypeORM connections, so concurrent transactions interleave. A rolled-back
write can survive if another request commits in between. Same SQL, same
migrations (run on startup). Writes are serialized, which is fine for one
user at personal scale.

The memory mode was the deployment's stopgap until PostgreSQL existed. Its
data was never kept, so the switch to PostgreSQL started from an empty
database: nothing was migrated.

## Database

**PostgreSQL**, confirmed as Money's production database. It is the backend's
only durable production mode, the one CI tests every change against (including
the locking and concurrency tests that PGlite can't run), and needs no
extension. spark-ops compared the alternatives (on-disk or in-memory PGlite,
SQLite) in its
[money-postgres.md](https://github.com/galarzafrancisco/spark-ops/blob/main/docs/money-postgres.md).

| | |
|---|---|
| Server | PostgreSQL 16 (16.15 at handover), Docker container `money-postgres` on the Spark host, `restart=always`, outside k3d |
| Database / role | `money` / `money`. The role owns the database and runs the migrations; it isn't a superuser and can't create roles or databases |
| From the pod | `money-postgres:5432` (`Service` + `EndpointSlice` from `base/postgres-service.yaml` → host `SPARK_IP`:15434) |
| Credentials | Secret `money-database`, key `DATABASE_URL`, injected with `secretKeyRef` (not optional) |
| TLS | none, host-local trusted transport (`DATABASE_SSL=false`) |
| Data on the host | `/home/fran/prod/storage/money/postgres` |
| Credentials on the host | `/home/fran/prod/secrets/prod-cluster/money-postgres.env` (`0600`) |
| Provisioning | spark-ops `./bootstrap/money-postgres.sh`, idempotent, also run by cluster bootstrap |

Data survives pod restarts and redeploys, database restarts, database container
recreation and k3d cluster recreation, as long as the host's storage survives.
It does **not** survive losing the Spark disk: see [Backups](#backups-and-restore).

**Schema.** spark-ops creates only the empty database and role. The app's
migrations create and update the schema on every startup
(`migrationsRun`, all-or-nothing transaction), and are a no-op when nothing is
pending. A failing migration stops the new pod (`CrashLoopBackOff`), and the old pod
keeps serving because the rolling update never marks the new pod ready. Test
migrations on Postgres before merging (CI does).

**Failure modes.** If `DATABASE_URL` is missing, production refuses to start
(`DATABASE_MODE=postgres requires DATABASE_URL`) and never falls back to
memory. If the Secret is missing, the pod stays in
`CreateContainerConfigError`. If Postgres is unreachable at startup, the app
retries, then exits and is restarted.

**Never** copy the `DATABASE_URL` value into the repository, a ConfigMap, task
comments or logs. `scripts/check-manifest-database.mjs` fails CI if the
manifests set it anywhere other than the Secret reference.

### Verifying a rollout

CI proves the image migrates a fresh Postgres and keeps data across a container
replacement, and the backend tests check records across an app restart
(`apps/backend/src/persistence.e2e.spec.ts`). Neither touches the production
database. After the first rollout in PostgreSQL mode:

```bash
kubectl -n money get pods                                  # 1/1 Running
kubectl -n money logs deploy/money | grep -i database      # "Database: PostgreSQL (DATABASE_URL)", no NOT DURABLE warning
docker exec money-postgres psql -U money -d money -c 'SELECT name FROM migrations ORDER BY id'   # on the Spark host
curl -s https://money.american-broomstick.com/health      # {"status":"ok"}
```

Then sign in, record something (an account is enough), `kubectl -n money
rollout restart deploy/money`, and check that it is still there.

## Backups and restore

Durable storage is not a backup. spark-ops documents the procedures (online
`pg_dump -Fc`, restore rehearsal on a separate database, image changes) in
[money-postgres.md](https://github.com/galarzafrancisco/spark-ops/blob/main/docs/money-postgres.md#backups).
**No scheduled or off-host backup exists yet**, so losing the Spark disk loses
every record.

What matters on Money's side:

- **What to keep.** The transactions, transfers, sale lot allocations,
  accounts, categories and users are the source of truth. Balances, lots,
  holdings and gains aren't stored, they are replayed. Valuation rows and
  cached prices can be recomputed (`valuations` guide), so a restore needs no
  special handling for them.
- **Also back up, separately:** the database credential file and the
  `money-session` key (`SESSION_ENCRYPTION_KEY`). Without the same key,
  restored browser sessions can't be decrypted and everyone signs in again;
  records are unaffected. Treat dumps as sensitive: they hold financial records
  and encrypted Taico tokens.
- **Restore into the live database with the app stopped:**
  `kubectl -n money scale deploy/money --replicas=0`, restore, then scale back
  to `1`. Argo CD self-heal puts the replica count back, so pause its sync
  (or restore quickly) if the restore takes time.
- **Restore a dump from the same or an older app version.** On startup the
  app runs any newer migrations forward. A dump from a newer version than the
  running image has migrations this image doesn't know, and isn't supported:
  deploy the matching version first.
- **No point-in-time recovery.** A restore goes back to the last dump.

## Secrets

Secrets are created out of band in the cluster and never committed.

| Secret (namespace `money`) | Keys | Status |
|---|---|---|
| `money-session` | `SESSION_ENCRYPTION_KEY`: 32 random bytes, base64 | **Provisioned.** Encrypts the Taico tokens of browser sessions at rest ([web-auth.md](../apps/backend/docs/web-auth.md)). Required: without it the pod stays in `CreateContainerConfigError`. Kept on the host like spark-ops' other secrets; back it up with the database. Rotating it ends all sessions; don't recreate it |
| `money-database` | `DATABASE_URL`: `postgresql://money:<password>@money-postgres:5432/money` | **Provisioned by spark-ops** (`bootstrap/money-postgres.sh`), which owns it. Not defined in Money's manifests (credentials). See [Database](#database) |

GHCR needs no pull secret if the package is public. spark-ops has no
`imagePullSecrets` anywhere.

## Outstanding prerequisites

None of these are confirmed done. A rendered manifest does not mean a working
deployment.

- **GHCR visibility.** `ghcr.io/galarzafrancisco/money` must be public, or the
  pod gets `ImagePullBackOff`. A separate task tracks this.
- **DNS.** `money.american-broomstick.com` must resolve to the gateway. On
  2026-10-22 it resolved to the same address as
  `address-australia.american-broomstick.com`. cert-manager can't issue
  `money-tls` until HTTP-01 reaches the gateway.
- **Taico registration of `money-api`** (`https://money.american-broomstick.com/api`,
  no scopes) for browser sign-in. Without it, `/auth/login` fails, but REST/MCP
  bearer auth and `/health` still work. No client registration is needed: the
  client_id defaults to the public `/auth/client-metadata.json`, which the route
  exposes. See [web-auth.md](../apps/backend/docs/web-auth.md).
- **Spark-ops hydration verification.** The first real `deploy/money-<sha7>`
  PR, its hydration, auto-merge, the `money-prod` Argo CD sync and a live
  `/health` are still to be checked.
- **First PostgreSQL rollout.** Startup migrations against `money-postgres`,
  live `/health`, and a signed-in record surviving a pod restart are still to
  be checked (see [Verifying a rollout](#verifying-a-rollout)).
- **Scheduled off-host backups** aren't configured. See
  [Backups and restore](#backups-and-restore).
