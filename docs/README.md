# Money docs

Repository-wide design guides and review checklists. Domain behaviour lives in
[apps/backend/docs/](../apps/backend/docs/), and agent instructions live in
[AGENTS.md](../AGENTS.md) (`CLAUDE.md` imports it).

| Path | What it is |
|---|---|
| [architecture/layering.md](architecture/layering.md) | Adapters → services → repositories, schemas, errors, testing by layer |
| [architecture/api-clients.md](architecture/api-clients.md) | Generated API clients with `@taico/openapi-sdkgen`: pipeline, rules, how the spec and `@money/client` are built |
| [review-guides/](review-guides/) | Objective checklists: controller, service, schema, entity, error, mcp, api-client, and guides for docs |
| [best-practices/node.md](best-practices/node.md), [best-practices/web.md](best-practices/web.md) | Project setup conventions |
| [ui/guidelines.md](ui/guidelines.md), [ui/review.md](ui/review.md) | UI architecture and style rules, and the mandatory UI review checklist |
| [ci.md](ci.md) | CI workflow: triggers, Postgres + PGlite test runs, image tags, spark-ops deployment PRs, secrets |
| [deployment.md](deployment.md) | Kubernetes manifests, the spark-ops/Argo CD flow, configuration, secrets, the PostgreSQL database with backup and restore notes, and outstanding prerequisites |

## Provenance

These guides were copied from Taico's
[ai-monorepo](https://github.com/galarzafrancisco/ai-monorepo) at `origin/main`
`00be0a8e` (2026-10-21) and adapted for Money. Money's code and product
boundaries win wherever they differ from Taico.

### What was copied and how it was adapted

| Taico source | Money file | Adaptation |
|---|---|---|
| `CLAUDE.md` / `AGENTS.md` | `AGENTS.md`, `CLAUDE.md` | Rewritten for Money: product boundaries, commands, layout, architecture, migrations and vendored auth. `CLAUDE.md` imports `AGENTS.md` instead of duplicating it |
| `docs/architecture/controller-responsibilities.md`, `service-transport-independence.md` | `architecture/layering.md` | Merged and condensed. The review snapshot sections (Taico tasks/context controllers) were dropped. Covers REST and MCP adapters, zod schemas instead of class-validator DTOs, and Money's `DomainError` |
| `CLAUDE.md` "API Generation Pipeline", `packages/openapi-sdkgen/README.md`, `docs/ui/guidelines.md` §6.2 | `architecture/api-clients.md`, `review-guides/api-client.md` | New Money doc that turns Taico's generated-client approach into a Money rule, with `@taico/openapi-sdkgen` from npm. Now also describes Money's implementation (`@ApiRoute`, response schemas, `@money/client`) |
| `docs/review-guides/review-guide.md`, `how-to-guide.md`, `best-practice.md` | same names | Copied, with typos fixed. The doc guides must match Money's code and not contradict its boundaries |
| `docs/review-guides/controller.md` | `review-guides/controller.md` | Swagger DTO items replaced with zod and `@AuthenticatedUser`. Added REST/MCP parity and the user-isolation check |
| `docs/review-guides/service.md` | `review-guides/service.md` | `TypeOrmModule.forFeature` replaced with Money's repository classes. Added user scoping, lock order, `decimal.js` and the outbound-call boundary |
| `docs/review-guides/dto.md` | `review-guides/schema.md` | Rewritten for zod `<domain>.schemas.ts` shared by services and MCP |
| `docs/review-guides/entity.md` | `review-guides/entity.md` | **"Money in integer cents" replaced with `numeric(30,10)` decimal strings**, Money's established precision decision. UUID PK instead of TEXT. No soft-delete column. Added composite same-user FKs, migration registration and the PGlite/Postgres dialect |
| `docs/review-guides/error.md` | `review-guides/error.md` | Taico's shared error codes, error catalog and RFC 7807 replaced with Money's `DomainError` and `{ error: { code, message, details } }` shape |
| `docs/review-guides/mcp.md` | `review-guides/mcp.md` | Kept the user-journey and short-description rules. Gateway and `@All('mcp')` wiring replaced with Money's per-request server, `toResult`, annotations and the "recording, not executing" wording |
| `docs/best-practices/node.md`, `web.md` | same names | Copied, with Money's Node version, Nx registration, `typecheck` and env-config rules added |
| `docs/ui/guidelines.md`, `docs/ui/review.md` | `ui/guidelines.md`, `ui/review.md` | Copied nearly verbatim. Examples use Money's domains. Auth defers to the UI authentication task instead of mandating a cookie. Added financial-data rules (decimal strings, currencies, price provenance, share-only valuations, no tax claims, no execution wording) |

### Not copied (intentionally)

- `docs/architecture/authorization-server.md`, `docs/how-to-guides/*`
  (create a backend/domain/entity, realtime events, threads, LLM, search),
  `docs/PRIMITIVES.md`, `DEPLOYMENT.md`: Taico application architecture that
  Money doesn't have. Money consumes Taico's auth server and doesn't host one.
- `docs/architecture/dto-mapping-patterns.md`, `enum-management.md`: written
  for class-validator/Swagger DTOs and TypeScript enums. The parts Money uses
  (mappers, `as const` arrays) are summarised in `architecture/layering.md`.
- `docs/best-practices/error.md` and `docs/reviews/*`: RFC 7807 and error
  catalog design, plus dated review reports of Taico modules.
- Taico's licensing rule (PolyForm-Small-Business-1.0.0). Money hasn't chosen a
  licence, so none is imposed here.
