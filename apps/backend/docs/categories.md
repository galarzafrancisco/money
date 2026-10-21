# Subaccounts, categories and reports

Money keeps two questions separate:

- **Where is the money held?** That is the account hierarchy: *Up! → Emergency
  Fund, Term Deposit 1, Term Deposit 2…*, or *Stake*.
- **How do I think about it?** That is a category: *alpha-high-risk*,
  *boring-etf*, *emergency*. Categories are your own free-text labels. They are
  not a fixed list of asset types.

Subaccounts are tracking constructs only. Creating one never opens a real bank
account.

## Subaccounts (buckets)

A subaccount is an ordinary account with a `parentAccountId`. It has its own
transactions, cash per currency, holdings and portfolio, exactly like a
top-level account.

| Rule | Detail |
|---|---|
| Ownership | The parent must be one of your accounts. Another user's account is answered with 404 (`not_found`). The database enforces this as well, with the composite FK `(parent_account_id, user_id) → accounts(id, user_id)`. |
| Depth | At most **5 levels**, where a top-level account is level 1. Exceeding it gives 409 with `details.maxDepth`. |
| Cycles | Moving an account under itself or under one of its own subaccounts gives 409 (`details.reason`: `self` or `cycle`). |
| Concurrency | Every hierarchy change (create, move, delete) first locks the user's row. Two concurrent moves therefore can't create a cycle together. |
| Names | Unique, ignoring case, among siblings: accounts with the same parent, or the top-level accounts. Two banks can each have a "Term Deposit 1". |
| Deleting | Refused (409, `details.subaccountCount`) while the account has subaccounts. Move or delete them first. |

### Roll-up: `own` and `rolledUp`

Every transaction belongs to exactly one account.

- **`own`** is the figure from that account's own ledger.
- **`rolledUp`** is `own` plus the `own` of every account below it.

The grand total (`totals` in the reports) is the sum of every account's `own`,
which equals the sum of the **top-level** accounts' `rolledUp`. Adding
`rolledUp` figures across levels (for example Up! plus Emergency Fund) counts
the Emergency Fund twice. Dashboards should add `own` figures, add top-level
`rolledUp` figures, or use `totals`.

### Moving money between buckets

A bucket is just an account. To record moving money into or out of one, record
a `WITHDRAWAL` on one account and a `DEPOSIT` on the other. Linked atomic
transfers are task 159468e5. They will work between buckets without extra work.

## Categories

A category has a `name` (unique per user, ignoring case, up to 80 characters),
an optional `description`, and an optional `color` (`#rrggbb`).

### Assigning a category: at most one per target

| Target | Where it's stored | How to set it |
|---|---|---|
| Account or subaccount | `accounts.category_id` | `categoryId` on create or update of the account (REST `PATCH /api/accounts/:id`, MCP `update_account`); `null` clears it |
| Holding, i.e. a symbol in one account (TSLA in Stake) | `holding_categories (account_id, symbol)` | REST `PUT /api/accounts/:id/holdings/:symbol/category`, MCP `set_holding_category`; `null` or `DELETE` clears it |

A holding assignment is keyed by account and symbol. It doesn't need the
symbol to be held right now, so it survives selling out and buying back in.

### Effective category, and why totals can't be inflated

Every valuation item is either a cash balance (one currency in one account) or
a holding (one symbol in one account). Each item gets **exactly one**
effective category, the first that applies of:

1. the holding's own category (holdings only);
2. its account's category;
3. the nearest ancestor account's category;
4. none: **Uncategorized** (`category: null` in reports).

The categories report therefore *partitions* the items. Category totals add up
to the grand total, and overlapping categories can't double-count anything.
The response gives each item's `categorySource` (`holding`, `account`,
`ancestor` or `none`), so a dashboard can explain where a category came from.

Several independent dimensions (for example risk *and* purpose) are not
supported. If they are needed, the proposed extension is *classification
groups*: one category per target per group, with each group still partitioning
the total.

### History

Categories are **current labels, not versioned history**. Renaming,
reassigning or deleting a category reclassifies every report, including
figures for past dates. Nothing is snapshotted. When daily valuations
(787fd88a) are materialised, they must decide whether to snapshot the
effective category alongside each valuation.

### Deleting a category

A category that is assigned to anything is only deleted with `unassign=true`
(REST query) or `unassign: true` (MCP). Its account assignments are set to
null and its holding assignments are removed. Those items then fall back to
whatever they inherit. Without the flag the request is refused with 409, and
`details` gives the counts `{ accounts, holdings }`.

## Reports

`GET /api/reports/accounts` (MCP `get_accounts_report`) and
`GET /api/reports/categories` (MCP `get_categories_report`) are both built from
the same list of valuation items, so they always agree.

| Option | Values | Meaning |
|---|---|---|
| `valuation` | `market` (default) or `cost` | `market`: holdings at the latest price × quantity. When no usable price exists (lookup failed, or the price is in another currency than the holding), the holding is valued at cost base and a message is added to `warnings`. `cost`: every holding at cost base. |
| `baseCurrency` | ISO code | Ask for converted totals as well |
| `fxRates` | REST: `USD:1.52,EUR:1.65`; MCP: `{ "USD": "1.52" }` | Units of `baseCurrency` per 1 unit of each currency. **Supplied by you.** Money doesn't look rates up. |
| `rootAccountId` | account ID | Limit the report to this account and its subaccounts |

FX policy:

- Totals are **always** given per currency (`byCurrency`: cash, holdings and
  total). Amounts in different currencies are never added together without a
  rate.
- `converted` is `null` unless `baseCurrency` is given. If it is given, every
  other currency in the report needs a rate; otherwise the request fails with
  400 and `details.missingRates`. Money is never silently left out of a
  converted total.
- `fxRates` without `baseCurrency` gives 400.
- The policy that was used is echoed back as `fx`.

Mock prices (`source: "mock"`) are flagged on every priced item
(`price.isMock`), and a warning is added to the report.

### Response shape (abridged)

```jsonc
// GET /api/reports/accounts?baseCurrency=AUD&fxRates=USD:1.5
{
  "asOf": "…", "valuation": "market", "fx": { "baseCurrency": "AUD", "rates": { "USD": "1.5" } },
  "priceProvider": "mock", "rootAccountId": null,
  "totals": { "byCurrency": [{ "currency": "AUD", "cash": "15100", "holdings": "0", "total": "15100" }, …],
              "converted": { "baseCurrency": "AUD", "cash": "…", "holdings": "…", "total": "…" } },
  "accounts": [{
    "id": "…", "name": "Up!", "level": 1, "parentAccountId": null,
    "categoryId": null, "effectiveCategory": null,
    "own": { … }, "rolledUp": { … },
    "items": [{ "kind": "cash", "currency": "AUD", "value": "100", "category": null, "categorySource": "none", … }],
    "children": [{ "name": "Emergency Fund", "level": 2, … }]
  }],
  "warnings": ["Some prices are mock …"], "notes": [ … ]
}

// GET /api/reports/categories
{
  …same envelope…,
  "categories": [
    { "category": { "id": "…", "name": "alpha-high-risk", "color": null }, "totals": { … },
      "items": [{ "accountPath": ["Stake"], "kind": "holding", "symbol": "TSLA", "quantity": "10",
                  "value": "2000", "costBase": "1500", "basis": "market", "categorySource": "holding", … }] },
    …,
    { "category": null, "totals": { … }, "items": [ … ] }   // Uncategorized, always last
  ]
}
```

Every one of your categories is listed, including those with no items, so a
dashboard can show empty buckets.

## User isolation

Accounts, categories, holding assignments and reports are all filtered by the
authenticated user. Another user's account or category IDs, whether used as a
parent, a category to assign, a `rootAccountId` or a path parameter, are
answered with 404 on REST and with `not_found` on MCP. Composite foreign keys
on `(id, user_id)` make cross-user references impossible in the database too.
