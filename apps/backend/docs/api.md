# REST and MCP

Both interfaces need `Authorization: Bearer <Taico access token>` whose audience
is the interface's URL (`$PUBLIC_BASE_URL/api` or `$PUBLIC_BASE_URL/mcp`). A 401
or 403 carries `WWW-Authenticate: Bearer resource_metadata="…"`.

The web app instead calls `/api` with its session cookie (and `X-CSRF-Token` on
unsafe methods). The cookie is exchanged for the session's Taico token before the
same checks run. A request with an `Authorization` header ignores the cookie.
`/mcp` never accepts the cookie. Browser sign-in endpoints (`/auth/login`,
`/auth/callback`, `/auth/session`, `/auth/logout`, `/auth/client-metadata.json`)
are described in [web-auth.md](web-auth.md).

Amounts are decimal strings. The MCP tools also accept JSON numbers and convert
them, but strings are preferred.

## OpenAPI spec and generated client

`npm -w @money/backend run build` writes `apps/backend/openapi.json` (OpenAPI 3.0).
`packages/client` (`@money/client`) generates the typed client from it with
`@taico/openapi-sdkgen`, and the web app uses that client. Each route's
metadata comes from its `@ApiRoute(...)` decorator: tag, `operationId`, the
service's zod query or body schema, and a response schema from
`<domain>.responses.ts`. The client's resources follow the tags:

- `money.accounts`, `transactions`, `lots`, `transfers`, `categories`;
- `money.reports`, `portfolio`, `prices`, `valuations`, `users`.

`POST /api/accounts/:id/transactions` appears as a single flattened
`RecordTransactionRequest`: a `type` enum plus every type's fields. The
generator has no `oneOf`, so the per-type rules below are enforced by the
service. The details are in
[docs/architecture/api-clients.md](../../../docs/architecture/api-clients.md).

## Up! import

The read-only Up! import (`/api/up/*`, `*_up_*` MCP tools, and the provider webhook
`POST /api/v1/webhooks/up`) is described in [up-integration.md](up-integration.md).

## Web app

After a build, the backend serves `apps/web/dist` (or `WEB_DIST_DIR`) at `/`.
That keeps the web app on the same origin as `/api` and `/auth`, which the
cookie session requires.

- Any `GET` that asks for HTML outside `/api`, `/auth`, `/mcp`, `/health` and
  `/.well-known` receives `index.html`.
- Hashed assets are cached for a year, and `index.html` is never cached.
- Without a build (API-only development), nothing extra is served.

## REST

| Method | Path | Body or query | Returns |
|---|---|---|---|
| GET | `/health` | none (no auth) | `{ status: "ok" }` |
| GET | `/api/me` | none | The Money user of the token |
| GET | `/api/accounts` | none | Accounts and subaccounts, flat, by name (`parentAccountId` links them) |
| POST | `/api/accounts` | `{ name, type?, reportingCurrency?, description?, parentAccountId?, categoryId? }` | Account (201) |
| GET | `/api/accounts/:id` | none | Account |
| PATCH | `/api/accounts/:id` | Any of the create fields; `parentAccountId: null` makes it top-level, `categoryId: null` makes it inherit | Account |
| DELETE | `/api/accounts/:id` | `?deleteTransactions=true` (required if it has transactions). Refused while it has subaccounts or takes part in transfers. | `{ deleted, transactionsDeleted }` |
| GET | `/api/accounts/:id/transactions` | `?type=&symbol=&fromDate=&toDate=` | Transactions in ledger order |
| POST | `/api/accounts/:id/transactions` | `{ type, date, … }` (see below) | Transaction (201) |
| GET | `/api/transactions/:id` | none | Transaction |
| PATCH | `/api/transactions/:id` | Fields valid for its type; `null` recalculates a calculable field. Refused (409) for transfer legs. | Transaction |
| DELETE | `/api/transactions/:id` | none. Refused (409) for transfer legs. | `{ deleted: true }` |
| GET | `/api/transfers` | `?accountId=` (either side) `&fromDate=&toDate=` | Transfers by date |
| POST | `/api/transfers` | `{ fromAccountId, toAccountId, date, fromCurrency, toCurrency?, fromAmount?, toAmount?, rate?, fees?, description? }` | Transfer (201) |
| GET | `/api/transfers/:id` | none | Transfer, with `outTransactionId` and `inTransactionId` |
| PATCH | `/api/transfers/:id` | Any of `date`, `description`, `fromCurrency`, `toCurrency`, `fromAmount`, `toAmount`, `rate`, `fees` (`null` recalculates). Accounts can't change. | Transfer |
| DELETE | `/api/transfers/:id` | none | `{ deleted: true, transactionsDeleted: 2 }` |
| GET | `/api/accounts/:id/lots` | `?symbol=&asOf=&excludeTransactionId=&includeClosed=` | Purchase lots (lotId = BUY id) with remaining quantity and cost base as of a date; see [lot-selection.md](lot-selection.md) |
| GET | `/api/transactions/:id/allocations` | none (SELL only; 400 otherwise) | How the sale was split across lots: per-lot cost base, proceeds, fees, gain, holding period, and totals |
| GET | `/api/accounts/:id/portfolio` | `?prices=false` skips price lookups | Cash, holdings with lots and valuations, realized gains, dividends, notes |
| GET | `/api/categories` | none | Your categories, by name |
| POST | `/api/categories` | `{ name, description?, color? }` | Category (201) |
| GET | `/api/categories/:id` | none | Category with `usage: { accounts, holdings }` |
| PATCH | `/api/categories/:id` | Any of the create fields | Category |
| DELETE | `/api/categories/:id` | `?unassign=true` (required if assigned) | `{ deleted, unassigned: { accounts, holdings } }` |
| GET | `/api/holding-categories` | `?accountId=` | Holdings that have their own category |
| PUT | `/api/accounts/:id/holdings/:symbol/category` | `{ categoryId }` (`null` clears) | `{ accountId, symbol, categoryId }` |
| DELETE | `/api/accounts/:id/holdings/:symbol/category` | none | `{ accountId, symbol, categoryId: null }` |
| GET | `/api/reports/accounts` | `?valuation=market\|cost&baseCurrency=&fxRates=USD:1.5,…&rootAccountId=` | Account tree with `own` and `rolledUp` totals |
| GET | `/api/reports/categories` | same | Totals per effective category (a partition of the total) |
| GET | `/api/dashboard` | `?displayCurrency=AUD\|USD…&fxRates=USD:1.5,…` | Total assets in one currency by asset class, category, account and ticker ([dashboard.md](dashboard.md)) |
| GET | `/api/valuations` | `?fromDate=&toDate=&accountId=&includeSubaccounts=&symbol=&include=totals\|holdings&baseCurrency=&fxRates=` | Daily closing-price valuations of holdings (see [valuations.md](valuations.md)) |
| GET | `/api/valuations/as-of` | `?date=&accountId=&includeSubaccounts=&symbol=&baseCurrency=&fxRates=` | Holdings and value at the close of one date: the snapshot, or reconstructed on demand (`basis`) |
| GET | `/api/valuations/status` | none | Materialised range, partial days, pending recompute, last job run |
| POST | `/api/valuations/recompute` | `{ fromDate, accountId?, refreshPrices? }` | 202 `{ requested, fromDate, accounts, refreshedSymbols }`; re-valued on the next job run |
| GET | `/api/market-prices/:symbol` | none | `{ symbol, price, currency, asOf, source, isMock, priceType, isStale, staleReason }` (see [market-prices.md](market-prices.md)) |
| GET | `/.well-known/oauth-protected-resource/{api,mcp}` | none (no auth) | RFC 9728 metadata |

Transaction bodies, by `type` (all of them take `date` YYYY-MM-DD and an optional `description`):

- `DEPOSIT` / `WITHDRAWAL`: `currency`, `amount`, optional `externalCurrency` + `externalAmount`
- `FX_CONVERSION`: `fromCurrency`, `toCurrency`, two of `fromAmount` / `toAmount` / `rate`, optional `fees`
- `BUY` / `SELL`: `symbol`, `currency`, three of `quantity` / `unitPrice` / `fees` / `total`
- `SELL` only: optional `allocations: [{ lotId, quantity }, …]` for specific identification (adding up to `quantity`); without it lots are matched FIFO. A SELL is returned with `lotSelection` (`FIFO`/`SPECIFIC`) and `allocations`. On `PATCH`, `allocations` replaces them and `null` switches to FIFO. See [lot-selection.md](lot-selection.md).
- `DIVIDEND`: `symbol`, `currency`, two of `grossAmount` / `withholdingTax` / `netAmount`, optional `frankingCredits`

Transactions also include `TRANSFER_OUT` / `TRANSFER_IN` legs, with
`transferId` and `counterpartyAccountId`. They are created only through
`/api/transfers`; see [transfers.md](transfers.md) for amounts, FX, edits and
reversal.

Subaccounts, categories and the reports, including roll-up, effective-category
and FX semantics, are described in [categories.md](categories.md).

Logical account groups (your own buckets over Money and Up accounts, one group per account) are described in [account-groups.md](account-groups.md): `/api/account-groups` and the `*_account_group(s)` MCP tools.

Example:

```http
POST /api/accounts/3f…/transactions
{ "type": "BUY", "date": "2025-01-10", "symbol": "VAS.AX", "currency": "AUD",
  "quantity": "100", "unitPrice": "95.12", "total": "9521.95" }
→ 201 { …, "fees": "9.95", "calculatedField": "fees" }
```

## MCP tools

The endpoint is `POST /mcp`, Streamable HTTP in stateless mode with JSON
responses. GET and DELETE answer 405. Every tool acts as the token's user, and
none of them takes a user argument.

| Tool | Does the same as |
|---|---|
| `whoami` | `GET /api/me` |
| `list_accounts`, `get_account`, `list_transactions` | Unified over manual and Up-imported accounts (`UnifiedAccountsService`): Up accounts appear as ordinary accounts with `source: "up"`, `visible` and cash `balances`, hidden ones included. REST `GET /api/accounts`, `GET /api/accounts/:id` and `GET /api/accounts/:id/transactions` use the same read model. Reports (accounts, categories) and the dashboard are still manual-ledger only. |
| `create_account`, `update_account`, `delete_account` | The account routes (manual accounts only) |
| `list_transactions`, `get_transaction` | The transaction reads |
| `record_deposit`, `record_withdrawal`, `record_fx_conversion`, `record_buy`, `record_sell`, `record_dividend` | `POST …/transactions` with that `type` |
| `update_transaction`, `delete_transaction` | `PATCH` / `DELETE /api/transactions/:id` |
| `record_transfer`, `list_transfers`, `get_transfer`, `update_transfer`, `delete_transfer` | The transfer routes |
| `list_lots`, `get_sale_allocations` | `GET /api/accounts/:id/lots`, `GET /api/transactions/:id/allocations` |
| `get_portfolio` | `GET /api/accounts/:id/portfolio` |
| `list_categories`, `get_category`, `create_category`, `update_category`, `delete_category` | The category routes |
| `set_holding_category` (`categoryId: null` clears), `list_holding_categories` | The holding-category routes |
| `get_accounts_report`, `get_categories_report` | `GET /api/reports/accounts`, `/categories` (`fxRates` as an object) |
| `get_dashboard` | `GET /api/dashboard` (`fxRates` as an object) |
| `get_valuation_history`, `get_valuation_as_of`, `get_valuation_status`, `request_valuation_recompute` | The valuation routes (`fxRates` as an object) |
| `get_market_price` | `GET /api/market-prices/:symbol` |

Results are JSON text content. Domain errors come back as `isError: true` with
the same `{ error: { code, message, details } }` body that REST returns.

## Errors

| HTTP | `code` | When |
|---|---|---|
| 400 | `validation_failed` | Bad input, e.g. fewer than three of the four trade fields, inconsistent totals, a field that doesn't apply to the type; a transfer to the same account, unequal same-currency amounts, or an attempt to change a transfer's accounts; a report with `baseCurrency` but a missing FX rate (`details.missingRates`) |
| 401 / 403 | (Bearer challenge) | Missing, invalid, expired or wrong-audience token |
| 401 | `session_expired` | Session cookie unknown, expired, signed out, or its refresh was refused (web app: sign in again) |
| 403 | `csrf_failed` | Unsafe request with the session cookie but without the right `X-CSRF-Token` |
| 503 | `auth_unavailable` | Taico unreachable while renewing a session's token; the session is kept |
| 404 | `not_found` | Doesn't exist, **or belongs to another user** |
| 409 | `conflict` | Duplicate account name among siblings or duplicate category name; deleting an account that has transactions, subaccounts or transfers; editing or deleting a transfer leg directly; a cycle or nesting deeper than 5 levels; deleting an assigned category without `unassign`; deleting a purchase that sales allocate shares from (`details.saleTransactionIds`) |
| 422 | `ledger_violation` | The change would make cash negative, oversell, or mix currencies for a ticker, or a sale's lot allocations would not fit (unknown lot, other ticker, bought after the sale, not enough left). For transfers, `details.side` says which account (`source`/`destination`). |
| 502 | `upstream_unavailable` | The price provider failed |
