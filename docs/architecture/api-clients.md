# Generated API clients

**Decision:** every TypeScript consumer of Money's REST API calls it through a
client **generated from the backend's OpenAPI spec with
[`@taico/openapi-sdkgen`](https://www.npmjs.com/package/@taico/openapi-sdkgen)**.
That includes the UI, seed scripts and any other Money app. This is Taico's
OpenAPI SDK generator, the one behind `@taico/client/v2`. Nobody hand-writes
request code or response types.

Adapted from Taico's API generation pipeline (`CLAUDE.md`, "API Generation
Pipeline"), the `packages/openapi-sdkgen` README and the "no handwritten API
calls" rule in `docs/ui/guidelines.md`.

## Why

- One contract. The backend is the source of truth for routes, parameters and
  shapes, so a backend change that breaks a consumer fails the consumer's build.
- No drift between hand-written types and real responses. This matters for
  decimal-string amounts and nullable fields.
- Instance-based auth (`getAccessToken`) with no global singleton, which suits
  multi-user isolation and tests.

## Pipeline

```
apps/backend ──(build)──► openapi.json ──► openapi-sdkgen ──► packages/client/src (generated)
                                                                   │
                                     apps/ui, scripts, … ◄──── import '@money/client'
```

1. The backend writes `apps/backend/openapi.json` during its build. Taico does
   this with a `--generate-openapi` mode that writes the spec and exits without
   serving.
2. A client package (planned name `@money/client`) runs
   `openapi-sdkgen <path>/openapi.json src/generated` in its build. Its Nx
   dependency on the backend makes the spec exist first.
3. Consumers depend on the client package and never import backend source.

Generated code is a build output. Don't edit it by hand. Fix the spec or the
generator instead.

## Usage shape

```ts
import { ApiClient } from '@money/client';

const money = new ApiClient({
  baseUrl: import.meta.env.VITE_MONEY_API_URL,
  // The web app uses the backend's cookie session (apps/backend/docs/web-auth.md):
  // no getAccessToken; the app-level session module adds X-CSRF-Token on unsafe requests.
  // Other TypeScript consumers pass getAccessToken: () => tokens.getAccessToken().
});

const accounts = await money.accounts.listAccounts();
```

Resources are grouped by OpenAPI tags. Tag every controller (`accounts`,
`transactions`, `transfers`, `categories`, `reports`, `valuations`, `lots`,
`portfolio`, `prices`) so the client has `money.accounts.*`,
`money.transfers.*` and so on.

## Rules for backend changes

- Every REST route appears in the spec with its request body, params, query and
  success response schema. A route missing from the spec is unreachable from
  generated clients.
- Spec schemas come from the same zod schemas the services parse (e.g. through
  zod's JSON Schema output). There's no second, hand-maintained schema set.
- Decimal amounts are `type: string` in the spec, matching the wire format.
- Error responses document the `{ error: { code, message, details } }` shape.
- The generator doesn't yet support `allOf`/`oneOf`/`anyOf`, file uploads,
  cookie parameters or complex security schemes. Model request bodies so the
  spec avoids them (discriminated transaction bodies may need one route per
  type, or a flattened schema), or extend the generator upstream in
  ai-monorepo.
- MCP isn't covered. MCP clients use the MCP tool schemas directly.

## How Money implements it

- **Route metadata.** Every `/api` controller method carries
  `@ApiRoute({ tag, operationId, summary, query?, body?, response })`
  (`apps/backend/src/openapi/api-route.decorator.ts`). Path, method and status
  come from Nest's own decorators.
- **Schemas.** Request bodies and query strings are the services' own zod input
  schemas, registered under a component name with `apiSchema('Name', schema)`.
  Responses are zod schemas in `<domain>/<domain>.responses.ts`, next to the
  view types the services return.
- **Spec.** `npm -w @money/backend run build` runs `nest build`, then
  `node dist/openapi/generate-spec.js`, which writes `apps/backend/openapi.json`
  (gitignored). It needs no database or configuration.
  `src/openapi/normalize.ts` turns zod's JSON Schema output into the generator's
  subset:
  - decimals (`string | number` on input) become `string`;
  - `X | null` becomes `nullable`;
  - the discriminated `RecordTransactionRequest` is flattened into one object
    with a `type` enum. The service still validates the exact variant.

  Anything that it can't express fails the build.
- **Client.** `packages/client` (`@money/client`) runs `openapi-sdkgen` into
  `src/generated` (gitignored), then compiles. It also exports `moneyErrorOf()`,
  which reads the `{ error: { code, message, details } }` envelope from an
  `ApiError`. Nx builds the backend first (`implicitDependencies`).
- **Web app.** `apps/web` creates one client per session in `src/app/api.tsx`
  with `credentials: 'same-origin'` and the session's `X-CSRF-Token` header.
  Feature data modules (`features/*/data.ts`) are its only callers. `/auth/*` is
  called from `src/app/session.tsx`, as web-auth.md prescribes.
- **Tests.** `apps/backend/src/openapi.e2e.spec.ts` fails when:
  - a route lacks metadata;
  - the spec contains `allOf`/`anyOf`/`oneOf`;
  - a real response doesn't match its response schema, field for field. Every
    operation is called against the running app.

### Known limits

- The generator interpolates path parameters without URL-encoding them. Ticker
  symbols are URL-safe in practice (`VAS.AX`), but a symbol with `/` or `#`
  would break. Fix upstream in `@taico/openapi-sdkgen`.
- `ApiError.message` is generic ("HTTP 422: …") because the generator looks for
  a top-level `message`. Use `moneyErrorOf(error).message`.
- Query booleans are typed as `'true' | 'false'` strings, which is their wire
  form.
