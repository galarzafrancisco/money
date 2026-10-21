# Review guide: zod schemas (Money's DTO equivalent)

Money uses zod schemas in `<domain>.schemas.ts` instead of class-validator DTOs.

- Schemas live in `<domain>.schemas.ts` and are used by both the service (`parseInput`) and the MCP tool (`inputSchema`).
- Shared formats use `src/common/validation.ts` helpers (`decimalString`, `currencyCode`, `isoDate`, `tickerSymbol`) instead of new regexes.
- Amounts, quantities, prices and rates are decimal strings, never `z.number()` outputs.
- Every field an MCP client sees has a short `.describe()`.
- Enumerations come from an `as const` array (e.g. `ACCOUNT_TYPES`) used with `z.enum`.
- Update schemas distinguish omitted (keep), `null` (clear/reset) and a value (set), and the difference is documented.
- No field allows choosing the user or another user's resources.
- Responses are plain objects produced by a mapper; entities are not returned.
- Sensitive fields (token claims beyond the user mapping, internal lock or lease data) are never exposed.
