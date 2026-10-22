# AGENTS.md

Guidance for coding agents (Claude Code, Codex and others) and human contributors
working in this repository. `CLAUDE.md` imports this file, so keep the rules here.

## What Money is

Money is a **multi-user personal investment tracker**: accounts and subaccounts,
multi-currency cash, FX conversions, transfers, share buys and sells, dividends,
cost bases per lot, gains, categories and daily valuations. The same business
services sit behind a REST API (`/api`) and an MCP server (`/mcp`).

### Product boundaries (non-negotiable)

- Money **only records and tracks**. Deposits, withdrawals, transfers, FX
  conversions, buys, sells and dividends are records of things that already
  happened elsewhere. They are entered by hand or sent by external automation.
- Money has **no banking or brokerage integrations**. It never moves real money,
  never contacts a bank or broker, and never places trades. Do not add code,
  endpoints, tools, wording or dependencies that suggest otherwise.
- The external automation that sends records is **outside this project's
  implementation scope**.
- **Market-price lookups are in scope**. They are the only outbound calls the
  backend makes.
- Authentication is **federated to Taico**. Money has no local login, passwords
  or sign-up.
- The web app signs in through the backend (`/auth/*`, a BFF with HttpOnly cookie
  sessions). Browser code never holds Taico tokens. See
  [apps/backend/docs/web-auth.md](apps/backend/docs/web-auth.md).
- **Strict user isolation** on every transport. The user comes only from the
  validated token's `(iss, sub)`. Another user's resource answers `404`, never
  `403`.
- Figures are tracking aids, **not tax advice**. Do not make authoritative tax
  claims in code, docs, API descriptions or UI copy.

## Development

```bash
npm run build:dev   # cloned -> ready: npm ci, build every project, verify @taico/auth imports
npm run dev         # run the backend in watch mode (http://localhost:4180)
npm run dev:web     # Vite dev server for the web app (http://localhost:5173), proxying /api and /auth to 4180
npm test            # every project's tests
npm run typecheck   # every project
```

Builds are orchestrated by **Nx** over npm workspaces. The order is:
backend (which also writes `apps/backend/openapi.json`) →
`@money/client` (generated from the spec) → `@money/web`. After `npm run build`,
the backend serves the web app at `/`. Without `DATABASE_URL`,
the backend uses embedded PGlite in `apps/backend/.data/pglite`. If port 4180
is in use, set `PORT`. Production needs `DATABASE_URL` (deployed: PostgreSQL,
URL from the spark-ops Secret `money-database`), or an explicit
`DATABASE_MODE=memory` (temporary and non-durable: data is lost on every
restart, never deployed). See [docs/deployment.md](docs/deployment.md).

### After making changes

1. `npm run build:dev`: everything compiles.
2. `npm test`: tests pass. Concurrency tests need `TEST_POSTGRES_URL` and are
   skipped without it, so say so if you didn't run them.
3. `npm run dev`: the app starts and `/health` answers. Unauthenticated `/api`
   and `/mcp` answer `401`. After a build, `/` serves the web app.

CI (`.github/workflows/ci.yml`) runs the suite on both Postgres and PGlite,
smoke-tests the container image, renders `install/manifests`, and on `main`
pushes the image and opens a spark-ops deployment PR that auto-merges. **A
merge to `main` deploys to https://money.american-broomstick.com right away.**
See [docs/ci.md](docs/ci.md) and [docs/deployment.md](docs/deployment.md).

## Repository layout

```
apps/
├── backend/   @money/backend: NestJS 11, TypeORM, Postgres/PGlite, MCP SDK, zod, Jest; writes openapi.json
└── web/       @money/web: React 19 + Vite web app (accounts, holdings, recording activity), Vitest
packages/
└── client/    @money/client: REST client generated from openapi.json by @taico/openapi-sdkgen (build output)
install/
└── manifests/ Kustomize base + overlays/main, copied to spark-ops by CI (docs/deployment.md)
docs/          repository-wide guides (index: docs/README.md)
```

## Architecture in one paragraph

```
REST controllers ─┐
                  ├─► services (zod parsing, business rules) ─► repositories (user-scoped) ─► Postgres
MCP tools ────────┘          └─► ledger engine (pure replay) / MarketPriceProvider port
```

Controllers and MCP tools are **adapters only**. Services own validation and
every business rule. Repositories take the owning user on every method.
Transactions are the source of truth. Balances, lots, holdings, cost bases and
gains are derived by replay and never stored. Amounts are decimal strings and
Postgres `numeric`, never floats. Details: [docs/architecture/layering.md](docs/architecture/layering.md)
and [apps/backend/docs/data-model.md](apps/backend/docs/data-model.md).

## API clients

Frontends and other TypeScript consumers call the backend **only through
clients generated from the backend's OpenAPI spec with
[`@taico/openapi-sdkgen`](https://www.npmjs.com/package/@taico/openapi-sdkgen)**
(Taico's OpenAPI SDK generator). Hand-written `fetch`/`axios` calls are not
allowed in feature code. Every `/api` route carries `@ApiRoute` metadata and a
response schema, so it appears in the spec. See [docs/architecture/api-clients.md](docs/architecture/api-clients.md).

## Guides

Read these before you change the matching kind of code. Reviewers check
against the review guides.

| Area | Design guide | Review checklist |
|---|---|---|
| Layering, controllers, services | [architecture/layering.md](docs/architecture/layering.md) | [controller](docs/review-guides/controller.md), [service](docs/review-guides/service.md) |
| Input/output schemas | [architecture/layering.md](docs/architecture/layering.md) | [schema](docs/review-guides/schema.md) |
| Entities and migrations | [apps/backend/docs/data-model.md](apps/backend/docs/data-model.md) | [entity](docs/review-guides/entity.md) |
| Errors | [architecture/layering.md](docs/architecture/layering.md#errors) | [error](docs/review-guides/error.md) |
| MCP tools | [apps/backend/docs/api.md](apps/backend/docs/api.md) | [mcp](docs/review-guides/mcp.md) |
| Generated API clients | [architecture/api-clients.md](docs/architecture/api-clients.md) | [api-client](docs/review-guides/api-client.md) |
| UI | [ui/guidelines.md](docs/ui/guidelines.md) | [ui/review.md](docs/ui/review.md) |
| Node / web project setup | [best-practices/node.md](docs/best-practices/node.md), [best-practices/web.md](docs/best-practices/web.md) | |
| Writing docs | | [review-guide](docs/review-guides/review-guide.md), [how-to-guide](docs/review-guides/how-to-guide.md), [best-practice](docs/review-guides/best-practice.md) |

Domain behaviour (categories, transfers, lot selection, valuations, accounting
assumptions) is documented in [apps/backend/docs/](apps/backend/docs/).

## Database migrations

- The schema changes **only through migrations** in
  `apps/backend/src/database/migrations`. Schema synchronization is never enabled.
- Register every new migration (and entity) in
  `apps/backend/src/database/entities.ts` (`MIGRATIONS`, `ENTITIES`), with
  migrations in chronological order. Migrations run on startup.
- Each migration has a working `down`. Test up/down/up on Postgres when you can.
- The SQL must run on both Postgres and PGlite. There is one dialect and one
  migration set.

## `@taico/auth`

Taico federated auth comes from the published
[`@taico/auth`](https://www.npmjs.com/package/@taico/auth) npm package, a regular
dependency of `@money/backend`. Do not copy or patch it in this repo. Fix it
upstream in ai-monorepo, publish a new version and bump the dependency.
`npm run verify:auth` checks that every public subpath of the installed package
loads.
