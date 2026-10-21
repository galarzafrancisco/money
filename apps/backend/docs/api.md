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
| GET | `/api/market-prices/:symbol` | none | `{ symbol, price, currency, asOf, source, isMock }` |
| GET | `/.well-known/oauth-protected-resource/{api,mcp}` | none (no auth) | RFC 9728 metadata |

Transaction bodies, by `type` (all of them take `date` YYYY-MM-DD and an optional `description`):

- `DEPOSIT` / `WITHDRAWAL`: `currency`, `amount`, optional `externalCurrency` + `externalAmount`
- `FX_CONVERSION`: `fromCurrency`, `toCurrency`, two of `fromAmount` / `toAmount` / `rate`, optional `fees`
- `BUY` / `SELL`: `symbol`, `currency`, three of `quantity` / `unitPrice` / `fees` / `total`
- `DIVIDEND`: `symbol`, `currency`, two of `grossAmount` / `withholdingTax` / `netAmount`, optional `frankingCredits`

Transactions also include `TRANSFER_OUT` / `TRANSFER_IN` legs, with
`transferId` and `counterpartyAccountId`. They are created only through
`/api/transfers`; see [transfers.md](transfers.md) for amounts, FX, edits and
reversal.

Subaccounts, categories and the reports, including roll-up, effective-category
and FX semantics, are described in [categories.md](categories.md).

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
| `record_transfer`, `list_transfers`, `get_transfer`, `update_transfer`, `delete_transfer` | The transfer routes |
| `get_portfolio` | `GET /api/accounts/:id/portfolio` |
| `list_categories`, `get_category`, `create_category`, `update_category`, `delete_category` | The category routes |
| `set_holding_category` (`categoryId: null` clears), `list_holding_categories` | The holding-category routes |
| `get_accounts_report`, `get_categories_report` | `GET /api/reports/accounts`, `/categories` (`fxRates` as an object) |
| `get_market_price` | `GET /api/market-prices/:symbol` |

Results are JSON text content. Domain errors come back as `isError: true` with
the same `{ error: { code, message, details } }` body that REST returns.

## Errors

| HTTP | `code` | When |
|---|---|---|
| 400 | `validation_failed` | Bad input, e.g. fewer than three of the four trade fields, inconsistent totals, a field that doesn't apply to the type; a transfer to the same account, unequal same-currency amounts, or an attempt to change a transfer's accounts; a report with `baseCurrency` but a missing FX rate (`details.missingRates`) |
| 401 / 403 | (Bearer challenge) | Missing, invalid, expired or wrong-audience token |
| 404 | `not_found` | Doesn't exist, **or belongs to another user** |
| 409 | `conflict` | Duplicate account name among siblings or duplicate category name; deleting an account that has transactions, subaccounts or transfers; editing or deleting a transfer leg directly; a cycle or nesting deeper than 5 levels; deleting an assigned category without `unassign` |
| 422 | `ledger_violation` | The change would make cash negative, oversell, or mix currencies for a ticker. For transfers, `details.side` says which account (`source`/`destination`). |
| 502 | `upstream_unavailable` | The price provider failed |
