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
