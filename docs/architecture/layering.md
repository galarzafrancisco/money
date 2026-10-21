# Layering: adapters, services, repositories

Adapted from Taico's `docs/architecture/controller-responsibilities.md` and
`docs/architecture/service-transport-independence.md`. The principles are the
same. The mechanics follow Money's code: zod schemas instead of class-validator
DTOs, and one `DomainError` hierarchy shared by REST and MCP.

```
REST controller ─┐
                 ├─► Service ─► Repository ─► Postgres / PGlite
MCP tool ────────┘      ├─► ledger engine (pure)
                        └─► MarketPriceProvider port (mock | yahoo)
```

## Principles

1. **One implementation of each rule.** REST and MCP are two doors into the
   same services. If a rule exists in only one adapter, it's a bug.
2. **Adapters are thin.** Controllers and MCP tools read the authenticated
   user and pass input through. They don't validate, compute, query or branch
   on business state.
3. **Services are transport-independent.** A service can be called from a
   controller, an MCP tool, a CLI job (`valuations:run`) or a test without
   change.
4. **Repositories are user-scoped.** Every method takes the owning user's ID
   and every query filters on it.
5. **Derived state is derived.** Cash, lots, holdings, cost bases, gains and
   dividends come from replaying transactions (`src/ledger`). They are never
   stored as a second source of truth.

## Adapters (controllers and MCP tools)

Allowed:

- Routing (`@Get`, `@Post`, …), explicit status codes (`@HttpCode`) and `@Protected()`.
- Taking the user with `@AuthenticatedUser()`, or binding it when the MCP server
  is built for the request.
- Passing the raw body, params and query to the service, including trivial
  reshaping. For example, `unassign === 'true'` becomes a boolean.
- MCP: reusing the service's zod shapes as `inputSchema`, writing short
  descriptions and annotations, and wrapping results and `DomainError`s with
  the shared `toResult` helper.

Not allowed:

```ts
// ❌ Repository access in an adapter
@Get('accounts/:id')
get(@Param('id') id: string) {
  return this.repo.findOne({ where: { id } }); // no user scope, bypasses the service
}

// ❌ Business validation in an adapter
@Post('transactions')
create(@Body() body: CreateTx) {
  if (body.type === 'SELL' && !body.allocations) throw new BadRequestException();
}

// ❌ Accounting in an adapter
@Get('gains')
async gains() {
  const txs = await this.service.list(user);
  return txs.reduce((sum, t) => sum + Number(t.total), 0); // floats, and duplicates the ledger
}

// ❌ The user taken from input
@Get('accounts')
list(@Query('userId') userId: string) { … }
```

## Services

Allowed:

- `@Injectable()`, `Logger`, repositories, the unit of work, other domain
  services, the ledger engine and ports such as `MarketPriceProvider`.
- Parsing input with `parseInput(schema, input)` from `src/common/validation.ts`.
- Throwing subclasses of `DomainError` from `src/common/errors.ts`.
- Opening transactions and taking row locks in the documented lock order (see
  `apps/backend/docs/data-model.md`).

Not allowed:

- Importing `HttpException`, `NotFoundException` or anything else from
  `@nestjs/common` other than DI and `Logger`.
- Express/Fastify `Request`/`Response`, `@Req()`, `@Res()` or headers.
- MCP SDK types or `CallToolResult`.
- Reading a user ID from input. The service receives `CurrentUser` as its own
  argument.

## Schemas and types

Money doesn't use class-validator DTO classes. Each domain has a
`<domain>.schemas.ts` with zod schemas:

- The **service** parses with them, so REST and MCP get the same validation and
  error messages.
- The **MCP adapter** uses the same shapes as tool input schemas.
- Shared building blocks (`decimalString`, `currencyCode`, `isoDate`,
  `tickerSymbol`) live in `src/common/validation.ts`. Use them instead of
  redefining formats.
- Enumerations are `as const` arrays with a derived union type, e.g.
  `ACCOUNT_TYPES` and `AccountType`. Use those arrays in zod (`z.enum(...)`) and
  in entity column types. Don't use string literals scattered through the code.
- Entities are mapped to plain response objects (e.g. `transaction.mapper.ts`).
  Entities are never returned to callers.

## Errors

`DomainError` subclasses carry a stable `code`, a message, optional `details` and
an `httpStatus`. The status is data, not a dependency on HTTP. Two adapters
translate them:

- **REST**: `DomainErrorFilter` → `{ error: { code, message, details? } }` with `httpStatus`.
- **MCP**: `toResult` → `isError: true` with the same code, message and details.

| Class | `code` | Status | Use |
|---|---|---|---|
| `ValidationError` | `validation_failed` | 400 | Input fails a schema or a simple rule |
| `NotFoundError` | `not_found` | 404 | Missing, or **owned by another user** |
| `ConflictError` | `conflict` | 409 | The change conflicts with dependent records |
| `LedgerViolationError` | `ledger_violation` | 422 | Replay would break the ledger (negative cash, overselling, mixed currencies) |
| `UpstreamError` | `upstream_unavailable` | 502 | A market-price provider failed |

Add a new class only for a new `code` that clients need to handle differently.
Put the facts a client needs in `details`, e.g. `saleTransactionIds` or
`missingRates`.

> Taico uses RFC 7807 Problem Details and a central error catalog. Money
> deliberately keeps its smaller `{ error: { code, message, details } }` shape,
> which the backend docs and UI handoffs already depend on.

## Testing by layer

- **Pure logic** (ledger, trade maths, aggregation, valuation maths): unit tests
  with no Nest or database.
- **Services and adapters**: e2e specs through REST and MCP against PGlite, with
  real tokens from a test issuer.
- **Concurrency and locking**: Postgres-only specs (`TEST_POSTGRES_URL`).
  PGlite is single-connection and can't reproduce races.
