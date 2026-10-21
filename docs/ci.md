# CI and image delivery

Money's pipeline is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
It follows the ai-monorepo flow: test, build and push an image, then open a
pull request on `galarzafrancisco/spark-ops` that deploys it.

## Triggers and jobs

| Event | `test` (postgres, pglite) | `image` | `publish` | `release-tag` | `deploy` |
|---|---|---|---|---|---|
| Pull request to `main` or `feature/**` | ✔ | build + smoke test | | | |
| Push to `main` (a merge) | ✔ | build + smoke test | ✔ push to GHCR | | ✔ |
| Release published | ✔ | | | ✔ | |

All jobs run on `ubuntu-24.04-arm`, and the image is `linux/arm64` for the DGX Spark.
A new commit to a pull request cancels the older run for it. Runs on `main` are
never cancelled, so every merge reaches spark-ops.

### `test`

The suite runs twice, as a matrix:

- **postgres**: a `postgres:16-alpine` service, with `TEST_POSTGRES_URL` set to
  its admin connection. Each test file creates and drops its own database. Only
  this leg runs the concurrency, lock-ordering and trigger tests, which are
  skipped on PGlite.
- **pglite**: no `TEST_POSTGRES_URL`. Each test file gets an in-memory PGlite in a
  child process. Development uses this back end, and so does the temporary
  in-memory deployment.

Both legs are required. The Postgres leg does not depend on how production is
deployed: keep it when the runtime changes.

Each leg runs `npm ci`, `npm run build`, `npm run verify:auth`, `npm run typecheck`,
the `@taico/auth` tests and the backend Jest suite. Jest runs with
`--maxWorkers=2`. Every test file boots a full app and its own database, and
unbounded parallelism has run out of memory on large machines.

### `image`

This job builds the [`Dockerfile`](../Dockerfile), a two-stage `node:24-alpine`
build that runs as the `node` user and listens on `PORT=4180`. Then it
smoke-tests the image: it starts the container with `NODE_ENV=production` against a
Postgres service and checks that migrations run, `/health` answers, and
unauthenticated `/api` and `/mcp` return `401`.

The job never pushes and has a read-only token (`contents: read`). It runs
pull-request code, and a PR can change workflow steps, so it must not hold
`packages: write`.

### `publish`

Only on pushes to `main`, after `image` passes, this job rebuilds the same
commit (layers come from the GitHub Actions build cache that `image` filled), logs
in to GHCR and pushes the tags below. It is the only branch-build job with
`packages: write`, and it never runs for `pull_request` events, so a pull
request can't get a token that writes to GHCR.

### `release-tag`

When a GitHub release is published, this job re-tags the existing
`main-<sha7>` image of the release commit with the release tag. Nothing is rebuilt.

### `deploy`

After a push to `main`, this job:

1. copies `install/manifests/` to `spark-ops/k8s/money/` (it replaces the old copy),
2. runs `kustomize edit set image ghcr.io/galarzafrancisco/money=ghcr.io/galarzafrancisco/money:main-<sha7>` in `k8s/money/base`,
3. opens the PR `Deploy money (main-<sha7>)` on spark-ops from the branch
   `deploy/money-<sha7>`, with the labels `automated-deployment` and `money`.

spark-ops' `hydrate-and-merge` workflow then writes `env.env` into
`k8s/*/overlays/main` and **auto-merges** the PR, unless the PR is a draft.

If `install/manifests/base/kustomization.yaml` doesn't exist, the job prints a
notice and opens no PR. The image is still pushed.

## Image naming

| Tag | When |
|---|---|
| `ghcr.io/galarzafrancisco/money:main-<sha7>` | every push to `main`; spark-ops deploys this tag |
| `ghcr.io/galarzafrancisco/money:main` | every push to `main` (moving) |
| `ghcr.io/galarzafrancisco/money:latest` | every push to `main` (moving) |
| `ghcr.io/galarzafrancisco/money:<release-tag>` | release published, promoted from `main-<sha7>` |

## Secrets

| Name | Used by | Purpose |
|---|---|---|
| `SPARK_OPS_TOKEN` | `deploy` | Check out spark-ops and open the deployment PR there. Same name as in ai-monorepo |
| `GITHUB_TOKEN` (automatic) | `publish`, `release-tag` | Push to GHCR (`packages: write`). Every other job gets `contents: read` only |

Secrets are only passed to actions and are never echoed. Pull requests never
receive `SPARK_OPS_TOKEN` or a GHCR-writable `GITHUB_TOKEN`. The `deploy`,
`publish` and `release-tag` jobs never run on `pull_request` events.

## Contract with the deployment manifests

The manifests are owned by the deployment-manifests task, not by CI. The
`deploy` job expects:

- `install/manifests/base/kustomization.yaml` exists and references the image
  `ghcr.io/galarzafrancisco/money` (in `images:` or in a resource), so that
  `kustomize edit set image` pins it;
- `install/manifests/overlays/main/` exists, because spark-ops hydration writes `env.env` there
  and fails if no `k8s/*/overlays/main` exists;
- the container listens on `4180` and serves `/health` for probes.

Because spark-ops auto-merges, a merge to `main` that changes `install/manifests`
**deploys immediately**. Review manifest changes with that in mind.

## Assumptions and known gaps

- **The image refuses to start without `DATABASE_URL` in production.** The
  temporary in-memory database mode for the first deployment belongs to the
  manifests task. CI only smoke-tests the image against Postgres.
- **GHCR package visibility.** The first push creates the
  `ghcr.io/galarzafrancisco/money` package, which may be private. The cluster
  needs to be able to pull it, either because the package is public or through
  an image pull secret, as for ai-monorepo.
- There is no linter step, because no linter is configured.
- There is no OpenAPI or generated-client step yet, because Money doesn't emit
  a spec (see [architecture/api-clients.md](architecture/api-clients.md)).
- Action versions match ai-monorepo, except for `docker/build-push-action@v6`.

## Running the same checks locally

```bash
npm run build:dev && npm run typecheck && npm test
TEST_POSTGRES_URL=postgresql://user:pass@localhost:5432/postgres npm -w @money/backend test -- --maxWorkers=2
docker build -t money:local .
```
