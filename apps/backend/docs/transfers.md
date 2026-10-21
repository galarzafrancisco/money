# Transfers between accounts

A transfer records money moving between two of **your own** accounts or
subaccounts (buckets), for example from your bank account into "Term Deposit 1",
or from an AUD account to a USD brokerage account. Like everything else in
Money it is a **record only**: nothing contacts a bank or moves real money.

## What is stored

A row in `transfers` is the source of truth: `fromAccountId`, `toAccountId`,
`date`, `description`, `fromCurrency`/`fromAmount`, `toCurrency`/`toAmount`,
`rate` and `fees`. It owns two linked ledger transactions:

| Leg | Account | Cash effect |
|---|---|---|
| `TRANSFER_OUT` | source | `−(fromAmount + fees)` in `fromCurrency` |
| `TRANSFER_IN` | destination | `+toAmount` in `toCurrency` |

Each leg has `transferId` and `counterpartyAccountId`. The legs are ordinary
ledger entries, so balances, portfolios and the account and category reports
include them with no special cases. In the account tree, moving money between a
parent and its bucket leaves the parent's `rolledUp` total unchanged, apart from
any fees.

## Amounts and FX

- **One currency** (`toCurrency` omitted or equal to `fromCurrency`): give
  `fromAmount`, or `toAmount`. The full amount arrives (`toAmount = fromAmount`,
  `rate = 1`); if both are given they must match. A `rate` other than 1 is
  refused.
- **Between currencies**: give `toCurrency` and any two of `fromAmount`,
  `toAmount` and `rate` (units of `toCurrency` per unit of `fromCurrency`). The
  third is calculated as it is for `FX_CONVERSION`: amounts are rounded to the
  currency's minor unit, a rate to 10 places, and with all three given they
  must agree within 0.01. `isFx: true` marks these transfers, and the rate used
  is stored and returned explicitly.
- `fees` (default 0) are charged in `fromCurrency` to the source, on top of
  `fromAmount`. They never reduce what arrives. To record "1000 AUD left, 650
  USD arrived", give the two amounts and let Money calculate the rate.

`calculatedField` says which figure Money worked out (`toAmount` for a
same-currency transfer given `fromAmount`).

## Validation

- Both accounts must be the caller's. Another user's account, or a malformed
  ID, gives 404 (`Source account …` / `Destination account …`), so a
  cross-user transfer is impossible. Composite `(id, user_id)` foreign keys
  enforce this in the database as well.
- The two accounts must differ (400).
- The source must hold enough `fromCurrency` on the transfer's date, fees
  included. Otherwise you get 422 `ledger_violation`, with `details.side`
  (`source`/`destination`), `accountId`, `transferId`, `currency`, `required`
  and `available`.

## Atomicity and locking

Create, edit and delete each run in one database transaction:

1. lock **both account rows, in id order** (the global lock order in
   [data-model.md](data-model.md#lock-order); transfers take no user or
   category locks);
2. load both accounts' transactions and apply the change to each;
3. replay **both** ledgers;
4. write the transfer and both legs only if both replays succeed.

So a transfer can never be half recorded, and two transfers that spend the same
cash are serialized. Locking in id order means two accounts transferring to
each other at the same moment cannot deadlock. `src/transfers.e2e.spec.ts`
checks this against real Postgres (`TEST_POSTGRES_URL`).

## Edits

`PATCH /api/transfers/:id` (MCP `update_transfer`) can change `date`,
`description`, `fromCurrency`, `toCurrency`, `fromAmount`, `toAmount`, `rate`
and `fees`. Both legs are updated together, keeping their IDs and `sequence`.
Fields left out keep their values; the previously calculated field is
recalculated unless given; `null` asks for a field to be recalculated. Within
one currency, a new `fromAmount` or `toAmount` sets both. An edit is rejected
if **either** ledger would break, for example when the destination already
spent money the edit removes, or a later date leaves an earlier spend unfunded.

**The accounts cannot be changed.** Delete the transfer and record a new one.

## Deletion and reversal

- **Delete** (`DELETE /api/transfers/:id`, MCP `delete_transfer`) is the
  correction for a transfer recorded by mistake. Both legs go with it. It is
  refused (422) if either ledger depends on it.
- **Reversal**: if the money really came back, record a **new transfer in the
  opposite direction**, with its own date, amounts and rate. There is no
  automatic "reverse" action: a real return happens on its own date and at its
  own FX rate, and keeping the history shows both movements.
- A leg can't be edited or deleted on its own: `PATCH`/`DELETE
  /api/transactions/:id` on a leg returns 409 with `details.transferId`. Legs
  can't be recorded through `POST …/transactions` either.
- An account that takes part in any transfer can't be deleted (409,
  `details.transferCount`), even with `deleteTransactions=true`. Otherwise the
  other account would be left with half a transfer. Delete the transfers first.
