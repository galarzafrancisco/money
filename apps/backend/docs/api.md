# REST and MCP

Both interfaces need `Authorization: Bearer <Taico access token>` whose audience
is the interface's URL (`$PUBLIC_BASE_URL/api` or `$PUBLIC_BASE_URL/mcp`). A 401
or 403 carries `WWW-Authenticate: Bearer resource_metadata="…"`.

Amounts are decimal strings. The MCP tools also accept JSON numbers and convert
them, but strings are preferred.

## REST

| Method | Path | Body or query | Returns |
|---|---|---|---|
| GET | `/health` | none (no auth) | `{ status: "ok" }` |
| GET | `/api/me` | none | The Money user of the token |
| GET | `/api/accounts` | none | Accounts, by name |
| POST | `/api/accounts` | `{ name, type?, reportingCurrency?, description? }` | Account (201) |
| GET | `/api/accounts/:id` | none | Account |
| PATCH | `/api/accounts/:id` | Any of the create fields | Account |
| DELETE | `/api/accounts/:id` | `?deleteTransactions=true` (required if it has transactions) | `{ deleted, transactionsDeleted }` |
| GET | `/api/accounts/:id/transactions` | `?type=&symbol=&fromDate=&toDate=` | Transactions in ledger order |
| POST | `/api/accounts/:id/transactions` | `{ type, date, … }` (see below) | Transaction (201) |
| GET | `/api/transactions/:id` | none | Transaction |
| PATCH | `/api/transactions/:id` | Fields valid for its type; `null` recalculates a calculable field | Transaction |
| DELETE | `/api/transactions/:id` | none | `{ deleted: true }` |
| GET | `/api/accounts/:id/portfolio` | `?prices=false` skips price lookups | Cash, holdings with lots and valuations, realized gains, dividends, notes |
| GET | `/api/market-prices/:symbol` | none | `{ symbol, price, currency, asOf, source, isMock }` |
| GET | `/.well-known/oauth-protected-resource/{api,mcp}` | none (no auth) | RFC 9728 metadata |

Transaction bodies, by `type` (all of them take `date` YYYY-MM-DD and an optional `description`):

- `DEPOSIT` / `WITHDRAWAL`: `currency`, `amount`, optional `externalCurrency` + `externalAmount`
- `FX_CONVERSION`: `fromCurrency`, `toCurrency`, two of `fromAmount` / `toAmount` / `rate`, optional `fees`
- `BUY` / `SELL`: `symbol`, `currency`, three of `quantity` / `unitPrice` / `fees` / `total`
- `DIVIDEND`: `symbol`, `currency`, two of `grossAmount` / `withholdingTax` / `netAmount`, optional `frankingCredits`

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
| `list_accounts`, `get_account`, `create_account`, `update_account`, `delete_account` | The account routes |
| `list_transactions`, `get_transaction` | The transaction reads |
| `record_deposit`, `record_withdrawal`, `record_fx_conversion`, `record_buy`, `record_sell`, `record_dividend` | `POST …/transactions` with that `type` |
| `update_transaction`, `delete_transaction` | `PATCH` / `DELETE /api/transactions/:id` |
| `get_portfolio` | `GET /api/accounts/:id/portfolio` |
| `get_market_price` | `GET /api/market-prices/:symbol` |

Results are JSON text content. Domain errors come back as `isError: true` with
the same `{ error: { code, message, details } }` body that REST returns.

## Errors

| HTTP | `code` | When |
|---|---|---|
| 400 | `validation_failed` | Bad input, e.g. fewer than three of the four trade fields, inconsistent totals, a field that doesn't apply to the type |
| 401 / 403 | (Bearer challenge) | Missing, invalid, expired or wrong-audience token |
| 404 | `not_found` | Doesn't exist, **or belongs to another user** |
| 409 | `conflict` | Duplicate account name; deleting an account that has transactions |
| 422 | `ledger_violation` | The change would make cash negative, oversell, or mix currencies for a ticker |
| 502 | `upstream_unavailable` | The price provider failed |
