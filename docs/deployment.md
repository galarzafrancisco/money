# Deployment

Money runs on the DGX Spark k3d cluster (`prod-cluster`) through the same flow
as Taico: **Money CI → spark-ops PR → hydration and auto-merge → Argo CD**.
Public URL: **https://money.american-broomstick.com**.

> **The current deployment is TEMPORARY and NOT DURABLE.** There is no
> PostgreSQL for Money yet, so the pod runs with `DATABASE_MODE=memory`.
> Every restart, redeploy (every merge to `main`), eviction, OOM kill or node
> reboot starts from an **empty database** and signs everyone out. Do not keep
> real financial records in it. Persistent storage is a separate task.

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
right away**, and in memory mode it also **wipes all data**. The `manifests`
CI job renders the overlay on every PR, the same way `deploy` does.

## Manifests

```
install/manifests/
├── base/
│   ├── kustomization.yaml   namespace money; images: ghcr.io/galarzafrancisco/money (CI pins newTag)
│   ├── namespace.yaml       sync-wave -2
│   ├── configmap.yaml       money-config: all non-secret settings
│   ├── deployment.yaml      1 replica, Recreate, probes on /health, hardened pod
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
  Taico's. Money's settings aren't secret, so they live in `configmap.yaml`
  and the overlay doesn't read `env.env`. It still has to exist, because
  hydration needs `overlays/main/`.
- **No volume, no Postgres Service or EndpointSlice.** Money has no host storage
  or database yet.
- **The image serves the web app** at `/` from the same origin as `/api` and
  `/auth` (the Dockerfile copies `apps/web/dist`), so the cookie session works
  without CORS or a separate frontend deployment. CI's smoke test checks that
  `/accounts` returns the app.
- **Probes use `/health`.** The liveness probe is lenient because a restart
  wipes the in-memory data.
- **The pod is hardened**: it runs as non-root with a read-only root
  filesystem, no capabilities and a 64Mi `/tmp`. CI smoke-tests the image
  with the same restrictions.

### Validating locally

```bash
kubectl kustomize install/manifests/overlays/main            # render
# or exactly as CI does, on a copy:
cp -r install/manifests /tmp/money && (cd /tmp/money/base && \
  kustomize edit set image ghcr.io/galarzafrancisco/money=ghcr.io/galarzafrancisco/money:main-0000000) && \
  kustomize build /tmp/money/overlays/main
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
| `DATABASE_MODE` | `memory` | **Temporary, non-durable.** See below |
| `MARKET_PRICE_PROVIDER` | `mock` | Deterministic, labelled mock prices. `yahoo` is the unofficial, keyless opt-in |

Browser sign-in ([web-auth.md](../apps/backend/docs/web-auth.md)) uses its
defaults, so it needs no ConfigMap entries: `TAICO_WEB_SERVER_ID=money-api`,
authorization server `https://taico.app/mcp/money-api/0.0.0`, client_id
`https://money.american-broomstick.com/auth/client-metadata.json`, callback
`/auth/callback`, `WEB_APP_URL=$PUBLIC_BASE_URL`, and `__Host-` Secure cookies
(because the base URL is https). Sessions are stored in the database, so in
memory mode they are lost on restart too.

The valuation job runs hourly in the pod (`VALUATION_*` defaults). Its database
lease and `valuations:run` are described in
[apps/backend/docs/valuations.md](../apps/backend/docs/valuations.md).
`valuations:run` refuses memory mode, because a second process would get its
own, empty database.

### `DATABASE_MODE`

| Mode | Database | Production |
|---|---|---|
| unset | Postgres when `DATABASE_URL` is set, otherwise on-disk PGlite | needs `DATABASE_URL` |
| `postgres` | `DATABASE_URL` (required) | yes, and it is the only durable option |
| `memory` | in-memory PGlite, empty on every start | allowed, but **temporary and non-durable** |
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

To move to Postgres: put `DATABASE_URL` in a Secret, reference it from the
Deployment, and remove `DATABASE_MODE` from the ConfigMap. Pin the Postgres
image as described in spark-ops' README. Nothing in memory survives, so there
is nothing to migrate.

## Secrets

Secrets are created out of band in the cluster and never committed.

| Secret (namespace `money`) | Keys | Status |
|---|---|---|
| `money-session` | `SESSION_ENCRYPTION_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`) | **Required, not provisioned yet.** It encrypts the Taico tokens of browser sessions at rest ([web-auth.md](../apps/backend/docs/web-auth.md)). The reference is not optional: until the Secret exists, the pod stays in `CreateContainerConfigError`, and production would refuse to start without the key anyway. Follow spark-ops' pattern for `taico-secrets-encryption`: generate once, store `0600` under `/home/fran/prod/secrets/prod-cluster/`, restore with a bootstrap script. Rotating it ends all sessions |

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
- **`money-session` Secret** with `SESSION_ENCRYPTION_KEY`. **The pod won't start
  without it.** See Secrets. For a one-off manual start:
  `kubectl -n money create secret generic money-session --from-literal=SESSION_ENCRYPTION_KEY="$(openssl rand -base64 32)"`.
  That isn't persisted outside the cluster, which is acceptable only while all
  data is in memory anyway.
- **Taico registration of `money-api`** (`https://money.american-broomstick.com/api`,
  no scopes) for browser sign-in. Without it, `/auth/login` fails, but REST/MCP
  bearer auth and `/health` still work. No client registration is needed: the
  client_id defaults to the public `/auth/client-metadata.json`, which the route
  exposes. See [web-auth.md](../apps/backend/docs/web-auth.md).
- **Spark-ops hydration verification.** The first real `deploy/money-<sha7>`
  PR, its hydration, auto-merge, the `money-prod` Argo CD sync and a live
  `/health` are still to be checked.
- **Persistent storage.** Until Money has PostgreSQL, every deploy loses all
  data.
