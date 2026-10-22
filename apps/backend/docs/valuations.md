# Daily closing-price valuations

Money keeps a daily history of what each user's holdings were worth at the
market close. Charts of value over time read it through
`GET /api/valuations` or the `get_valuation_history` MCP tool. One date can be
read, or reconstructed on demand, through `GET /api/valuations/as-of`
(`get_valuation_as_of`). Closes come from the shared, store-first price
history described in [market-prices.md](market-prices.md).

Personal tracking only: the job reads prices; it never trades or moves money.

## What a snapshot is

For each user and **valuation date D**, the job stores:

- `valuation_days`: one row per (user, D): `status` (`COMPLETE` or
  `PARTIAL`), the price provider used and when it was computed.
- `valuation_holdings`: one row per (user, D, account, symbol). It records:
  - `quantity`, `cost_base` and `lots`, matched by each sale's stored allocations or FIFO (lot id, acquired on, remaining
    quantity, cost base, market value) **as held at the end of D**. The job
    replays the account's ledger up to D, so the quantities are the ones held
    on D, not today's.
  - the close used: `close_price`, `price_currency`, `price_date` (the
    trading date of the close), `price_close_time`, `exchange_timezone`,
    `price_source` and `price_is_mock`.
  - `price_status`, `market_value` (quantity × close, or null) and
    `price_note`.

Holdings only. Cash balances are not snapshotted (yet). They can be derived
by replaying the ledger, and they need no price.

**Categories are not stored.** Categories are current, unversioned labels
(see [categories.md](categories.md)). Consumers join snapshot rows to the
current categories by `(accountId, symbol)`. Changing a category therefore
reclassifies past values too, as the reports already do.

## Which close values a date

A valuation date is a calendar date. Each holding is valued at the close of
**its own exchange's trading session dated D, in the exchange's local time
zone**. For example, D = Tuesday uses the ASX close at 16:00 Sydney time and
the NYSE close at 16:00 New York time. These are different instants, ~14
hours apart.

| `price_status` | Meaning | `market_value` |
|---|---|---|
| `CLOSE` | The close of the session dated D | quantity × close |
| `NON_TRADING_DAY` | No session on D: a weekend, or a weekday when the provider has a later session but none for D (a public holiday). Uses the last close before D; `price_date` says which. | quantity × that close |
| `PRICE_PENDING` | A weekday with no close for D and no later session yet. It may be delayed, unavailable, or a holiday not yet confirmed. Uses the last close as an indication, clearly flagged. | quantity × that close (provisional) |
| `MISSING` | No usable close: the provider failed and nothing is stored, the symbol is unknown, or the last close is more than `VALUATION_MAX_CARRY_DAYS` old | null |
| `CURRENCY_MISMATCH` | The provider prices it in another currency than it was traded in | null |

A day is `COMPLETE` when every holding is `CLOSE` or `NON_TRADING_DAY`.
Otherwise it is `PARTIAL`. A stale price is never presented as a fresh close:
the status and `price_date` always show which session's close was used. Cost
base is never used in place of a missing price.

There is no exchange holiday calendar. Weekends are non-trading for every
exchange Money supports, and all of them trade Monday to Friday. Holidays
are inferred from the provider's history once a later session exists. Until
then a holiday shows as `PRICE_PENDING`, and the recheck turns it into
`NON_TRADING_DAY`. Exchanges with other weekends (e.g. Middle East markets)
are not handled specially.

## Schedule

The job runs inside the backend process (`ValuationScheduler`): 15 s after
startup, then every `VALUATION_JOB_INTERVAL_MINUTES` (default 60). Each run
does only what is due, so frequent runs are cheap. A run:

1. takes the job lease (`valuation_job_state`). If another instance holds an
   unexpired lease (30 min), the run is skipped. Multiple replicas are safe.
2. for each user with purchases, works out the **due dates** in
   `[max(first BUY, today − VALUATION_BACKFILL_DAYS), settledThrough]`:
   - dates with no snapshot yet (first run, backfill, missed runs or downtime);
   - `PARTIAL` days within the last `VALUATION_RECHECK_DAYS` (re-tried each
     run until complete or out of the window);
   - days computed with a different price provider (switching from `mock` to
     `yahoo` replaces the mock history);
   - days on or after a pending recompute request (see below).
   At most `VALUATION_MAX_DAYS_PER_RUN` dates per user per run; the rest wait
   for the next run.
3. replays each account's ledger for those dates, reads the needed closes from
   the price store (asking the provider only for dates not stored yet, see
   [market-prices.md](market-prices.md)), and **replaces** each (user, date)
   in one database transaction.

**Date D is due** at D+1 `VALUATION_SETTLE_HOUR_UTC`:00 UTC (default 06:00).
By then the US close of D (20:00/21:00 UTC) and the ASX close (05:00/06:00 UTC
on D) are final. Separately, providers only report sessions that have
finished; the Yahoo adapter also waits 30 minutes after the scheduled close.
So an intraday price is never stored as a close.

### Idempotency and retries

A (user, date) is deleted and rewritten in one transaction, with unique keys
on `(user_id, valuation_date)` and `(user_id, valuation_date, account_id,
symbol)`. Re-running, retrying a failed run, or running two instances at
once never duplicates rows, and readers never see half a day. A failure
while valuing one user is logged and recorded in the run outcome. Other users
continue, and the next run tries again.

### Backdated trades and edits

A trigger on `transactions` (`TRG_transactions_valuation_recompute`) fires on
every insert, update or delete of a BUY or SELL. It upserts
`valuation_recompute_requests(account_id, from_date = earliest affected date)`.
A second trigger on `sale_lot_allocations` requests a recompute from the
sale's date whenever a sale's lot allocations change. Each trigger runs in the
writer's own transaction, so every writer is covered: the transactions API,
transfers, and account deletion. The next run recomputes all
of the user's dates from `from_date`. Then it clears the request, unless it
was renewed meanwhile (compared on `requested_at`), in which case it stays for
the following run. If a backdated delete removes the first purchase,
snapshots before the new first purchase are deleted.

Deleting an account cascades its snapshot rows. Deleting a user cascades
everything.

### Missed runs and recovery

- **Downtime or missed runs**: the next run backfills every missing date.
  No action is needed.
- **Provider outage**: closes already stored are used as usual. Dates not
  stored yet are `MISSING` (or `PRICE_PENDING`) and their days are `PARTIAL`.
  They are re-tried for `VALUATION_RECHECK_DAYS`.
- **Corrected prices**: stored closes are final. Use
  `POST /api/valuations/recompute { fromDate, refreshPrices: true }` to fetch
  them again from `fromDate`. Any close that changed re-values every holder's
  dates from that date, for every user.
- **Older gaps** (outside the recheck window): call
  `POST /api/valuations/recompute { fromDate }` (MCP
  `request_valuation_recompute`). It marks the user's dates from `fromDate`
  for the next run.
- **Run it now**: `npm -w @money/backend run valuations:run` (after
  `npm run build`) runs one pass with the server's configuration and exits.
  The exit code is non-zero if the run was skipped or a user failed. The lease
  stops it overlapping a scheduled run.
- `GET /api/valuations/status` shows the user's materialised range, partial
  days, any pending recompute, and the last run's timing and status. The
  run's error text stays in the database and logs, because it may mention
  other users.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VALUATION_JOB_ENABLED` | `true` (`false` in tests) | Run the job on a timer in this process |
| `VALUATION_JOB_INTERVAL_MINUTES` | `60` | How often it looks for due work |
| `VALUATION_SETTLE_HOUR_UTC` | `6` | D is due at D+1 at this UTC hour |
| `VALUATION_BACKFILL_DAYS` | `366` | How far back history is materialised |
| `VALUATION_RECHECK_DAYS` | `7` | How long PARTIAL days are re-tried |
| `VALUATION_MAX_CARRY_DAYS` | `7` | The oldest previous close that may stand in for a non-trading or pending day |
| `VALUATION_MAX_DAYS_PER_RUN` | `400` | Dates per user per run |

## Providers

Closes come from the `MarketPriceProvider` port's `getDailyCloses`, through
the price store (`PriceHistoryService`). See [market-prices.md](market-prices.md)
for store-first lookups, Yahoo's caveats and configuration.

- **`mock`** (default): made-up closes on every weekday, around the
  symbol's mock price. Rows carry `price_source: "mock"`, `price_is_mock:
  true`, and history responses set `includesMockPrices`. Do not rely on them.
  Exchange and time zone are guessed from the suffix (`.AX` Sydney 16:00,
  `.L` London 16:30, `.TO` Toronto 16:00, otherwise New York 16:00).
- **`yahoo`**: Yahoo's chart endpoint with `interval=1d`. It is unofficial,
  with no SLA, and it may rate-limit or change. Notes:
  - The trading date comes from the bar's timestamp in the exchange time zone
    that Yahoo reports. The close time is the session's scheduled regular
    close (from `currentTradingPeriod`). Early closes (half days) are not
    reflected in `price_close_time`.
  - Yahoo's daily `close` is split-adjusted. The adapter reverses that with
    Yahoo's split events, so stored closes are **as traded** and match the
    ledger's recorded quantities. Corporate actions are not modelled: if a
    split happened while a holding was held, `price.note` says so, and the
    quantity after it may not match the shares really held.
  - Prices in minor units (`GBp`/`GBX` pence, `ZAc`, `ILA`) are converted to
    the major currency (GBP, ZAR, ILS) so they match trades recorded in it.

## FX

Totals are given **per currency**. Currencies are never added together
without an explicit policy. With `baseCurrency`:

- **Historical (default)**: each date is converted at that date's FX close
  (the pair `{CUR}{BASE}=X` from the price store, the latest close up to
  `VALUATION_MAX_CARRY_DAYS` before the date). `fx.policy` is `HISTORICAL`,
  and `totals.converted.rates` lists the rate, its trading date, source and
  `isMock` for each currency. If any currency has no rate for a date,
  `totals.converted` is `null` for that date and
  `totals.conversionUnavailable` says why. No other rate is substituted.
- **Constant**: with `fxRates` as well (same format as the reports), those
  rates are applied to every date. `fx.policy` is `CONSTANT`, and the
  description says these are not historical rates. A missing rate is a 400
  with `details.missingRates`.

Converted cost base uses the same date's rate. It is a translation for
charting, not an acquisition-date cost base, and it is not tax advice.

## As of a date

`GET /api/valuations/as-of?date=YYYY-MM-DD&accountId&includeSubaccounts&symbol&baseCurrency&fxRates`
(MCP `get_valuation_as_of`) returns the holdings at the end of `date` with
quantities, lots, the close used and totals, in the same shape as a history
day with `include=holdings`.

- `basis: SNAPSHOT`: the materialised snapshot, used when it exists, was
  priced by the current provider, is `COMPLETE` and has no pending recompute.
- `basis: ON_DEMAND`: otherwise (no snapshot yet, outside the backfill window,
  `PARTIAL`, or a backdated change or price correction not yet re-valued),
  computed now with the job's own code (`holdingsOn` in `valuation-math.ts`).
  It replays the ledger to `date` and reads closes from the price store,
  fetching the missing ones from `date − VALUATION_MAX_CARRY_DAYS` to
  `date + VALUATION_MAX_CARRY_DAYS`. `basisReason` says why. Nothing is
  stored. The job materialises the date on its next run, and for the same
  ledger and closes both give the same figures (tested).
- Bounds: one date per request, not after today. Older dates work, as far
  back as the provider has history.

History days and as-of results carry `pendingRecompute: true` when a
backdated change or price correction affects the date and has not been
re-valued yet.

## API

- `GET /api/valuations?fromDate&toDate&accountId&includeSubaccounts&symbol&include=totals|holdings&baseCurrency&fxRates`
  (`baseCurrency` alone converts at historical FX; see "FX").
  Defaults to the 90 days up to the latest materialised date. At most 3660
  days, or 366 with `include=holdings`. `accountId` includes its subaccounts
  unless `includeSubaccounts=false`. Each day has `complete` (for the
  holdings in scope), `includesMockPrices`, and `totals.byCurrency` with
  `marketValue` (valued holdings only), `costBase`, `holdings`,
  `unvaluedHoldings` and `provisionalHoldings`.
- `GET /api/valuations/status`
- `GET /api/valuations/as-of?date&accountId&includeSubaccounts&symbol&baseCurrency&fxRates`
  (see "As of a date").
- `POST /api/valuations/recompute { fromDate, accountId?, refreshPrices? }` → 202

MCP tools `get_valuation_history`, `get_valuation_as_of`, `get_valuation_status`
and `request_valuation_recompute` call the same service. Every query filters by
the token's user. Another user's `accountId` is a 404.
