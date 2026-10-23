# Merchant and account search

Read-only discovery so a client can resolve a name to a stable ID before
querying transactions, instead of downloading and scanning everything.
REST: `GET /api/search/merchants`, `GET /api/search/accounts`. MCP:
`search_merchants`, `search_accounts`. Both call `SearchService`.

## Accounts

`q` is optional (omit it to page through accounts in name order). Results cover
manual and Up-imported accounts: `id` (canonical, usable with `get_account` and
`list_transactions`), `name`, `source`, `type`, `currency`, `visible`,
`parentAccountId`, `removed`, `matchType`. Similarly named accounts are always
separate results. No balances, tokens or provider IDs are returned.

Visibility follows the rest of the API: manual accounts are always included;
imported Up accounts follow `visibility` (REST default `visible`, MCP default
`all`, like the other MCP tools).

## Merchants

Merchants come from the `description` of imported Up transactions, which is
Up's merchant/counterparty label. `rawText` and `message` are free text and are
not searched. Transfers between Up accounts and deleted transactions are
excluded. Manual ledger transactions have no merchant field, so they are not
searched.

**Merchant key.** Up gives no merchant ID, so Money derives
`merchantKey = "up:" + words joined by "-"` from the label: lowercased,
accent-free, punctuation removed, `&` read as `and`, trailing legal suffixes
(`Pty Ltd`, ...) and a trailing store number (2+ digits) dropped. `GUZMAN Y GOMEZ 1234`
and `Guzman y Gomez Pty Ltd` share one key (`up:guzman-y-gomez`). The key is
accepted by `GET /api/up/transactions?merchantKey=` (and `list_up_transactions`)
and matches every spelling that folds to it.

**Limits.**
- The key is only as good as the label. Two merchants Up labels identically are
  one; one merchant Up labels differently (`Woolies` vs `Woolworths`) is two.
- Stripping trailing numbers means `Shop 10` and `Shop 11` are one merchant.
- Keys can change if the normalisation rules change; do not store them long term.
- Visibility scopes the search: hidden accounts are searched only with
  `visibility=all|hidden` or an explicit `accountId`.

**Matching.** Each query word must be found in the name. `matchType` says how:
`exact` (same name), `alias` (same words, other spelling such as BBQ /
barbecue / barbeque, plurals), `prefix`, `partial`, `approximate` (small typos).
Aliases only decide what is shown; they never merge keys, so `BBQ Galore`
finds `Barbeques Galore` (alias) and not `BBQs In The Hills`. Treat anything
other than `exact` as a candidate to confirm.

Order: matchType, then transaction count, then name, then key. Pages use
`limit` (default 20, max 100) and `offset`; `nextOffset` is null on the last page.
The work is one grouped query over distinct labels, so large histories are cheap.

## Transaction search

`GET /api/search/transactions` and MCP `search_transactions` (same
`SearchService.transactions`). Everything is filtered, sorted and paged in the
database; clients never download history to scan it.

**Scope.** Imported Up transactions (live, not deleted) and manual cash-flow
transactions: deposits, withdrawals, buys, sells, dividends and (with
`transfers=include|only`) transfer legs. FX conversions and gain/loss entries
have no single cash amount and are not searched. Manual `amount` is the signed
cash effect (withdrawal and buy negative; deposit, sell and dividend net
positive). Manual rows carry `source: "manual"`, `type`, a plain `YYYY-MM-DD`
`date` (no timezone), `status: "SETTLED"`, `merchant: null` and their
description as `note`. Merchant filters and `status=HELD` therefore return Up
rows only. A manual transaction matched to an Up transaction in the searched
scope records the same event and is not listed: only the Up row is, so nothing
is counted twice (`reconciliation` shows the link). If the Up account is not in
scope, the manual record is listed normally.
Accounts: `accountIds` (comma-separated in REST) take manual or Up IDs from
`search_accounts`, and Up accounts are searched even when hidden. Without
`accountIds`, every manual account plus the Up accounts allowed by `visibility`
(REST `visible`, MCP `all`) are searched. Another user's or unknown account ID
answers `404`.
Ordering across sources: newest local day first (Up timestamps are read in
`timezone`), Up before manual on the same day. Each source is paged in the
database for the first `offset + limit` rows and then merged.

**Filters** (all optional, combined with AND):
- `merchantKey` (exact, from `search_merchants`) or `merchant` (a name,
  matched like `search_merchants`; the response's `matchedMerchants` lists what
  it resolved to, so check it). Not both. Merchant filters never return
  transfers.
- `text`: substring of description, raw text or message. Separate from merchants.
- `fromDate`/`toDate`: inclusive local dates, either may be omitted, read in
  `timezone` (IANA, default `UTC`; use `Australia/Sydney` for statement dates).
  Items carry a UTC timestamp in `date`.
- `minAmount`/`maxAmount`: inclusive, on the **absolute** amount, so a refund of
  50 and a purchase of 50 both match 50. They require `currency`; currencies
  are never compared or summed together. Use `direction` (`out` money leaving,
  `in` refunds/deposits, `any`) to separate purchases from refunds.
- `status` (`HELD`/`SETTLED`), `transfers` (`exclude` default, `include`, `only`).

**Result.** `items` newest first (ties by id) with `amount` signed, `direction`,
`currency`, `status`, `merchant`, `merchantKey`, `note`, `source` (`up`/`manual`), `type`,
`reconciliation`; `nextOffset` (null on the last page; `limit` default 50, max
200); `summary.totalCount` and `summary.byCurrency[]` (`moneyOut`, `moneyIn`,
`net`) over all matches; `matchedMerchants`; `scope`.

**Agent recipes.**
- "When did I buy at Guzman?": `search_merchants {q:"guzman"}` then
  `search_transactions {merchantKey:"up:guzman-y-gomez", direction:"out"}`.
- BBQ retailer AUD 100-400 in 2021-2024: `{merchantKey, currency:"AUD", minAmount:"100", maxAmount:"400", fromDate:"2021-01-01", toDate:"2024-12-31", direction:"out"}`.
- A manual account's withdrawals: `{accountIds:[manualId], direction:"out", currency:"AUD"}`.
- Spending account, Jan-Mar 2025, withdrawals AUD 50-200: `{accountIds:[id], fromDate:"2025-01-01", toDate:"2025-03-31", timezone:"Australia/Sydney", direction:"out", currency:"AUD", minAmount:"50", maxAmount:"200"}`.
- Last 12 months of spend: use `summary.byCurrency[].moneyOut`; do not add up pages.

Limits: offset paging (a sync between pages can shift rows); the merchant key
limits above apply; the date predicates use the `up_created_at` index only
partly, which is fine at tens of thousands of rows per user.
