# Stock splits

Money models stock splits, so historical valuations don't fall off a cliff
on a split date. The example that prompted this was TSLA's 5:1 split on
2020-08-31 and 3:1 split on 2022-08-25. Before, 645 shares were valued at
$2,213.40 on 2020-08-28 ($1.43M) and at $498.32 on 2020-08-31 ($321k): the
quantity was in today's share basis, but the closes were as traded.

Transactions are never rewritten. Splits are applied when the ledger is
replayed, like every other derived figure.

Tracking aid only, not tax advice. Corporate actions can have tax
consequences that Money doesn't assess.

## Share bases

A split `numerator:denominator` with **effective date** (ex-date) `E` turns
each share held at the end of `E − 1` into `numerator / denominator` shares
from `E` on. The as-traded close drops by the same ratio. A quantity "in the
basis of date B" counts shares as they stood at the end of B, with every
split `E <= B` applied. The **present basis** has every known split applied.

The cumulative **factor** of date D is the product of the ratios of the splits
effective after D. Today's quantity = quantity on D × factor. A present-basis
(split-adjusted) price = as-traded price on D ÷ factor. For TSLA:

| D | factor |
|---|---|
| up to 2020-08-30 (including the weekend before the split) | 15 |
| 2020-08-31 .. 2022-08-24 | 3 |
| from 2022-08-25 | 1 |

## The convention

| What | Basis |
|---|---|
| A BUY/SELL quantity, unit price and SPECIFIC lot allocations, as stored | The day the transaction was **recorded** (`created_at`, UTC date) |
| Ledger replay: cash, lots, cost bases, holdings, sales, gains (portfolio, lots, reports, dashboard, write validation) | **Present** basis: each trade is multiplied by the splits effective after the day it was recorded. Unit prices are divided by the same factor. Totals, fees, cost bases and proceeds don't change. |
| Daily valuations (`valuation_holdings`, `GET /api/valuations`, `/as-of`, MCP) | **The valuation date's own basis**: present quantity ÷ factor(D), times D's as-traded close. `split.adjustedQuantity` and `split.adjustedClose` give the present-basis figures. |
| Stored closes (`market_price_closes`) | Always `AS_TRADED`. Factors are never applied to stored closes. |

What this means in practice:

- **Imports in today's basis** (broker exports, trades entered after a split
  with split-adjusted quantities) are recorded after the splits, so their
  factor is 1. They are never adjusted twice. Today's TSLA data is unchanged
  in the portfolio and lots, and its history is now consistent.
- **Trades recorded as they happen** (before a later split) are scaled by the
  split once it is known. Lots, cost per share and later sales in the new
  basis then agree.
- **Limit:** a trade recorded today for a date before a split, with its
  *as-traded* (pre-split) quantity, is read in today's basis. Enter such
  trades split-adjusted. A per-transaction basis override is possible future
  work.

Value is invariant across a split when the market doesn't move, and real
price changes and trades are kept. The regression tests in
`src/splits/split-math.spec.ts` and `src/stock-splits.e2e.spec.ts` check both
TSLA boundaries, weekends, multiple splits, holdings without splits and MCP
output.

## Storage

| Table | Holds |
|---|---|
| `security_splits` | One row per `(instrument, effective_date)`: `numerator`, `denominator` (> 0), `provenance` (`VERIFIED` / `PROVIDER`), `source`, `note`, `created_at`, `updated_at` |
| `security_symbol_aliases` | Ticker changes: `symbol` (old) → `instrument`. A holding under the old symbol uses the instrument's splits. |
| `valuation_holdings.split_factor`, `split_adjusted_quantity`, `split_adjusted_close` | The basis of each snapshot row (null on rows written before splits were modelled; they are recomputed) |

These are market data, shared by every user, like the price store.
`market_price_splits` keeps the raw split events per provider, as before.

### Where splits come from

- **Verified**: added by migration (idempotent upsert). The
  `StockSplits1762400000000` migration seeds TSLA 2020-08-31 5:1 and
  2022-08-25 3:1. To add one, write a migration that upserts it with
  `provenance = 'VERIFIED'` and re-queues the holders (see that migration).
- **Provider**: each price fetch copies the splits the provider reports into
  `security_splits` as `PROVIDER` rows, keyed by the resolved instrument. A
  `VERIFIED` row is never changed by a provider. A different ratio is logged
  as a warning and ignored. Mock-provider splits only exist in tests.

### Recomputation

A new or changed split moves the share basis of every date before it. So
every account, of any user, that traded the instrument (or an alias) is
queued for re-valuation from its first trade in it
(`valuation_recompute_requests`, worked off newest first like any backfill).
The migration does the same for the seeded splits. A valuation run that
discovers a split while fetching closes values with it straight away.
On-demand as-of valuations do the same.

## API

- `GET /api/stock-splits?symbol&fromDate&toDate` (MCP `list_stock_splits`)
  lists splits by effective date, with ratio, provenance, source, the symbols
  each one applies to and a one-line explanation. An old ticker resolves to
  its instrument.
- `GET /api/stock-splits/adjustment?symbol&date` (MCP `get_split_adjustment`)
  returns `factor` from `date`'s basis to today's, with `splitsAfterDate`
  (making up the factor) and `splitsOnOrBeforeDate`.
- Valuation history adds `splits` (those effective in the range, for the
  symbols shown) and `holding.split { basis: VALUATION_DATE, factor,
  adjustedQuantity, adjustedClose }`. `price.note` names a split that
  happened while the holding was held.

All are read-only and need a signed-in user.
