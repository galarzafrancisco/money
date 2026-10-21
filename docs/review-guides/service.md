# Review guide: services

- No imports of HTTP exceptions, Express/Fastify types, `@Req()`/`@Res()`, MCP SDK types or Swagger decorators.
- Every public method takes `CurrentUser` (or the owning user ID) as an explicit argument and never reads a user ID from input.
- Input is parsed with `parseInput(schema, input)` using the domain's `<domain>.schemas.ts`.
- Throws only `DomainError` subclasses from `src/common/errors.ts`.
- Another user's resource, and a malformed ID, produce `NotFoundError`, never a 403 or a leak of existence.
- Interacts with other domains only through their public services, not their repositories.
- Writes that affect a ledger run in one transaction, lock the affected account rows in ID order, replay the ledger, and reject the whole change on any violation.
- Lock order follows `apps/backend/docs/data-model.md`; new locks are added to that document.
- Monetary arithmetic uses `decimal.js` and decimal strings; no `Number` arithmetic on amounts, quantities or rates.
- Does not record or imply a real-world instruction to a bank or broker; outbound calls are limited to market-price providers behind the `MarketPriceProvider` port.
- Data access goes through the domain's repository class (using the unit-of-work `EntityManager`), and new entities are registered in `src/database/entities.ts`.
