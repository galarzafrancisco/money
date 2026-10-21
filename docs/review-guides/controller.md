# Review guide: REST controllers

- Controller contains **no business logic**: no repository access, no accounting, no business validation, no branching on domain state.
- Every route is under `/api` and protected with `@Protected()`; any unauthenticated route (health, well-known metadata) is intentional and documented.
- The user comes from `@AuthenticatedUser()` only; no user ID is read from params, query, body or headers.
- Body, params and query are passed to the service, which parses them with zod; the controller does at most trivial reshaping (e.g. `'true'` → `true`).
- Errors are thrown by services as `DomainError`s and rendered by `DomainErrorFilter`; the controller does not throw `HttpException`s.
- Status codes are explicit where Nest's default is wrong (e.g. `@HttpCode(200)` on DELETE that returns a body).
- Every route has a matching MCP tool, or the PR states why not.
- Every route is documented in `apps/backend/docs/api.md` and is described in the OpenAPI spec once spec generation exists (see `docs/architecture/api-clients.md`).
