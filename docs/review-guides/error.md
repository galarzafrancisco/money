# Review guide: errors

- New failures are thrown as an existing `DomainError` subclass when the `code` fits; a new subclass is added to `src/common/errors.ts` only for a new client-visible `code`.
- Every `DomainError` has a stable snake_case `code`, a human-readable message and an `httpStatus`.
- `details` carries the facts a client needs to recover (IDs, offending transaction, missing rates), not stack traces or internals.
- REST renders errors as `{ error: { code, message, details? } }` via `DomainErrorFilter`; MCP returns the same JSON with `isError: true`.
- Another user's resource produces `not_found` (404).
- New codes are documented in `apps/backend/docs/api.md`.
- UI handles the new `code`, or has a safe default.
- Logs and error payloads contain no tokens or secrets.
