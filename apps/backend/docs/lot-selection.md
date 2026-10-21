# Lot selection: specific identification and FIFO

> **Not tax advice.** Per-lot holding periods and gains help with tax analysis.
> They are **not** a complete or authoritative Australian CGT calculation. See
> [accounting-assumptions.md](accounting-assumptions.md) for what is and isn't
> modelled. Most importantly, nothing is converted to AUD and no discount is
> applied.

When you record a sale you can say which purchases the shares came from, and
how many came from each. One sale can take part of several purchases. A sale
that doesn't say uses FIFO, as every sale did before this feature.

Example: lot A is 100 shares and lot B is 200. A sale of 40 allocated as 15
from A and 25 from B leaves A with 85 and B with 175.

## Lots

A **lot** (parcel) is one `BUY`. Its `lotId` is that BUY transaction's ID:

- **Stable.** It doesn't change when the ledger is replayed, or when the BUY
  or other transactions are edited.
- **Unique per purchase.** Several purchases on one date are separate lots.
  The purchase date alone is never used as identity.
- **Derived.** Lots are not a stored table. Remaining quantity and cost base
  come from replaying the account's ledger, like every other balance.

`GET /api/accounts/:id/lots` (MCP `list_lots`) lists lots with these fields:

- `lotId`, `buyTransactionId`, `accountId`, `symbol`, `currency`
- `acquiredOn`, `sequence`, `status` (`OPEN` or `CLOSED`)
- `originalQuantity`, `originalCostBase`, `unitCostBase`, `remainingQuantity`, `remainingCostBase`
- `daysHeld` and `heldOverTwelveMonths`, measured to `asOf` or today
- `disposals`: the sales that took shares from the lot

Query parameters:

| Param | Meaning |
|---|---|
| `symbol` | Only one ticker |
| `asOf` | Lots as they stood at the end of this date, i.e. what a sale dated `asOf` may allocate from. Default: after everything recorded. |
| `excludeTransactionId` | Leave out one SELL (the sale being edited), so the shares it took show as available again |
| `includeClosed` | `true` also lists fully sold lots |

## Recording a sale with allocations

```http
POST /api/accounts/:id/transactions
{ "type": "SELL", "date": "2025-03-01", "symbol": "VOO", "currency": "USD",
  "quantity": "40", "unitPrice": "30", "fees": "10",
  "allocations": [ { "lotId": "<lot A>", "quantity": "15" },
                   { "lotId": "<lot B>", "quantity": "25" } ] }
```

MCP `record_sell` takes the same `allocations`. The SELL comes back with
`lotSelection: "SPECIFIC"` and its `allocations`. A sale without allocations
has `lotSelection: "FIFO"` and `allocations: null`.

### Validation

| Rule | Error |
|---|---|
| At least one allocation, at most 1000; `lotId` a UUID; quantity a positive decimal with ≤ 10 dp | 400 `validation_failed` |
| Each lot at most once | 400 |
| Quantities add up exactly to the sale's quantity (after the three-of-four calculation) | 400 |
| `allocations` only on SELL | 400 |
| The lot is a BUY of the same ticker and currency **in this account** | 422 `ledger_violation` |
| The lot was acquired before the sale in ledger order (date, then order recorded). A purchase recorded later on the same date comes after the sale. | 422 |
| The lot still has the shares at that point of the history, after every earlier sale (FIFO or specific) | 422 |

**Ownership is never taken from the caller.** A lot ID is only looked up
among the authenticated user's transactions in the sale's own account. A lot
belonging to another user, or to another of your accounts, gets the same "not
a purchase of X in this account" answer as an ID that doesn't exist. It is
never a 403, and the error doesn't reveal the other lot's details. The
database enforces the same rule: allocations reference
`transactions (id, user_id, account_id)` for both the sale and the lot.

## Figures per allocation

`GET /api/transactions/:id/allocations` (MCP `get_sale_allocations`) works
for FIFO and specific sales alike. For each lot taken from it gives:

- `quantity`, `unitCostBase`, `costBase`
- `grossProceeds`, `fees`, `proceeds` (net) and `gain` (= `proceeds − costBase`)
- `daysHeld` and `heldOverTwelveMonths`

It also gives `totals` for the whole sale. Portfolio `realized.disposals`
carry the same fields plus `selection`.

### Precision, rounding and fee allocation

- **Cost base** of a slice = the lot's remaining cost base × slice quantity ÷
  the lot's remaining quantity, rounded to 10 dp (half-even). A slice that
  empties its lot takes the lot's **entire** remaining cost base, so a lot's
  sold and remaining cost bases always add up to its original cost base.
- **Fees and net proceeds** are shared pro-rata by quantity, rounded to
  10 dp. The **last allocation** (in the order given; for FIFO the newest lot
  touched) takes what is left, so the slices add up exactly to the sale's
  `fees` and `total`. `grossProceeds = proceeds + fees`.
- Stored amounts have 10 decimal places (`numeric(30,10)`). API values are
  canonical decimal strings. Supplied totals may differ from
  quantity × price ± fees by up to 0.01 (broker rounding); the slices
  reconcile to the stored total, not the recomputed one.

## FIFO versus specific identification

| | FIFO (default, `lotSelection: FIFO`) | Specific (`lotSelection: SPECIFIC`) |
|---|---|---|
| Which lots | Oldest open lots first, by (acquiredOn, sequence), at the point the sale replays | Exactly the lots and quantities stored with the sale |
| Stored | Nothing beyond the sale | `sale_lot_allocations` rows |
| After an earlier change | **Re-matched.** A backdated purchase or sale can change which lots a FIFO sale consumes, as before. | **Never re-matched.** If an earlier change leaves the allocations impossible, that change is refused. |

Every SELL that existed before migration `1761400000000-SaleLotAllocations`
is `FIFO`. The migration backfills `lot_selection = 'FIFO'` and changes no
figures. Rolling the migration back drops the allocations, and those sales
are then matched FIFO again.

## Edits, deletes and backdated changes

Every write runs in one database transaction:

1. lock the account row;
2. re-read all of the account's transactions with their allocations;
3. apply the change in memory;
4. replay the whole ledger.

If the replay finds anything inconsistent, nothing is written. There are no
partial updates.

| Change | Result |
|---|---|
| Edit a SELL with `allocations: [...]` | Replaces its allocations |
| Edit a SELL with `allocations: null` | Switches it to FIFO |
| Edit a SELL without `allocations` | Allocations are kept. If its quantity changes (directly or by recalculation), they must still add up to it: 400 otherwise. A changed symbol or date is checked against the lots: 422 if they no longer fit. |
| Delete a SELL | Its allocations go with it |
| Delete a BUY that sales allocate from | **409 `conflict`**, `details.saleTransactionIds` lists them. Re-allocate those sales or switch them to FIFO first. The database also refuses (deferred foreign key) if this check were bypassed. |
| Edit a BUY (quantity below what is allocated, date after a sale that names it, another symbol or currency) | 422; nothing is written |
| Backdated sale or purchase | Replayed in date order. A backdated FIFO sale that would consume shares a later specific sale names is refused (422). Give it allocations from other lots instead. |
| Delete an account (`deleteTransactions=true`) or user | Cascades: transactions and allocations are deleted together |

Concurrent writes to one account are serialized by the account row lock. Two
sales that each fit, but not together, cannot both succeed. Allocations never
cross accounts, so a single account lock is enough; transfers between
accounts move cash only, never lots.

## Valuation history

The daily valuation job replays each account with its stored allocations.
Historical holdings and the `lots` of each `valuation_holdings` snapshot
therefore reflect the lots each sale actually consumed on every date.

Changes are re-valued from the affected date:

- The existing trigger on `transactions` covers a BUY or SELL that is
  inserted, edited or deleted.
- A new trigger on `sale_lot_allocations` requests a recompute from the
  sale's date whenever allocations are added, changed or removed.

The valuation limitations and price provenance in
[valuations.md](valuations.md) are unchanged.

## Australian tax assumptions

- The ATO lets you identify which parcels you sold if you can tell them
  apart, and accepts FIFO when you can't. Money records your choice; it
  doesn't decide which is right for you, and it has no "minimise gain"
  automation.
- `heldOverTwelveMonths` is the 12-month test for the CGT discount, worked
  out per allocation. No discount is applied.
- Cost bases, proceeds and gains are **in the trade currency**. AUD
  conversion at the acquisition and disposal rates is still an open question
  (see accounting-assumptions.md).
- Corporate actions, AMIT cost-base adjustments, wash-sale considerations
  and capital-loss ordering are not modelled.

## UI contract (for the Accounts UI)

There's no frontend in this repo yet. The sell flow should work like this:

1. When the user enters a sale's account, symbol and date, call
   `GET /api/accounts/:id/lots?symbol=SYM&asOf=DATE`. When editing an
   existing sale, also pass `&excludeTransactionId=SALE_ID`.
2. Offer a choice between **FIFO** (the default; send no `allocations`) and
   **Choose lots**.
3. In **Choose lots**, show one row per open lot: purchase date, quantity
   left, unit cost and holding period (`daysHeld`, plus a "> 12 months"
   badge from `heldOverTwelveMonths`). Each row has a quantity input from 0
   to `remainingQuantity`. Lots bought on the same date are separate rows;
   distinguish them by unit cost and `sequence`.
4. Show a running total, and enable submit only when it equals the sale
   quantity. Send only the rows with a quantity above 0, in display order.
5. After saving, call `GET /api/transactions/:id/allocations` and show, per
   lot: quantity, cost base, fees share, net proceeds, gain and holding
   period, with the totals and the `notes` caveat.
6. Map errors as follows:
   - 400 means an input problem (show `error.message`).
   - 422 `ledger_violation` means the history doesn't allow it, for example
     "lot … has only 5 shares left on that date". Re-fetch the lots.
   - 409 on deleting a purchase means sales allocate from it; link to the
     sales in `details.saleTransactionIds`.
