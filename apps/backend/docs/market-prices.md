# Market prices

Money reads market prices to value holdings. It only reads them: it never
trades, and it has no broker or bank connection. Price lookups are the only
outbound calls the backend makes.

Every price path goes through one port, `MarketPriceProvider`
(`src/market-prices/market-price.port.ts`), chosen by `MARKET_PRICE_PROVIDER`:

| Provider | What it is | Use it for |
|---|---|---|
| `mock` (default) | Made-up, deterministic prices. Every value says `source: "mock"` and `isMock: true` | Development and tests |
| `yahoo` | Yahoo Finance's chart endpoint: keyless, delayed, **unofficial** | Real prices for personal tracking |

The provider is wrapped once (`ThrottledPriceProvider`), so the quotes, the
daily valuation job, on-demand as-of valuations, historical FX and the
dashboard all share one request limit and one retry policy.

## Enabling real prices

Set `MARKET_PRICE_PROVIDER=yahoo` and restart. Nothing else is needed: there is
no key and no account. Production sets it in
`install/manifests/base/configmap.yaml`.

What changes when you switch:

- Quotes, dashboards and portfolios show `source: "yahoo"` and `isMock: false`.
- The valuation job sees that the existing snapshots were priced by `mock` and
  re-values every date with Yahoo closes, newest first, in batches of
  `VALUATION_MAX_DAYS_PER_RUN` dates. Each symbol's closes are fetched once
  for the range a batch needs (one request per symbol and gap) and stored, so
  later batches and runs only ask for dates not stored yet.
- Mock and Yahoo closes are stored separately (keyed by `source`). Switching
  back to `mock` re-values with mock data again, and nothing is mixed.

Is Yahoo suitable? It is fine for personal tracking, which is what Money does.
It has no SLA, no published terms for this use, and it may rate-limit, change
its format or stop working without notice. Quotes may be delayed by 15 minutes
or more. Do not use it for anything that needs licensed market data. If it
fails, Money shows stored data with its age, or reports the price as missing.
It never shows mock prices or cost base in their place without saying so.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MARKET_PRICE_PROVIDER` | `mock` | `mock` or `yahoo` |
| `MARKET_PRICE_CACHE_SECONDS` | `300` | How long a latest quote or FX rate is reused before asking again (short TTL for intraday data) |
| `MARKET_PRICE_MAX_CONCURRENT` | `2` | Provider requests in flight at once, for the whole process |
| `MARKET_PRICE_MIN_INTERVAL_MS` | `250` with `yahoo`, else `0` | Minimum gap between the starts of two requests |
| `MARKET_PRICE_RETRIES` | `2` | Extra attempts after a transient failure (HTTP 429 or 5xx, timeout, network). Backoff starts at 1 s and doubles, and an HTTP `Retry-After` is honoured (max 30 s) |
| `MARKET_PRICE_MAX_FETCH_DAYS` | `3660` | The longest date range fetched in one request; longer gaps are fetched in parts |

The `VALUATION_*` settings in [valuations.md](valuations.md) decide how far back
history is needed.

## Latest quotes

`GET /api/market-prices/:symbol`, MCP `get_market_price`, the portfolio,
reports and the dashboard use `MarketPricesService`:

- A fresh quote is reused for `MARKET_PRICE_CACHE_SECONDS`, in process memory.
- `priceType`: `LAST` is the latest regular-market price. It may be intraday
  and delayed. `CLOSE` is the close of a finished session: Yahoo's latest
  price outside regular hours, or a stored close used as a fallback.
- When the provider fails, the last quote fetched in this process is served.
  If there is none, the latest close in the price store is served. Either way
  the quote has `isStale: true`, a `staleReason`, and its real `asOf`. The
  dashboard rates such a holding `STALE`, and reports add a warning. If
  nothing is known, the lookup fails (502 `upstream_unavailable`). The
  holding is then valued at cost and flagged `COST_FALLBACK`, as before.
- FX rates (`getFxRate`, used by the dashboard) work the same way. The stored
  fallback is the pair's latest daily close (e.g. `AUDUSD=X`).

## Daily closes: the price store

Daily closes (`getDailyCloses`) back the valuation job, on-demand as-of
valuations and historical FX. They are read from the database first.

| Table | Holds |
|---|---|
| `market_price_closes` | One close per `(symbol, source, trading_date)`, with `currency`, `exchange_timezone`, `close_time`, `is_mock`, `adjustment`, `fetched_at`, `revised_at` |
| `market_price_series` | Per `(symbol, source)`: currency, exchange time zone, adjustment, and `covered_from`..`covered_to`, the envelope of the covered ranges |
| `market_price_coverage` | Per `(symbol, source)`: the disjoint ranges of trading dates known to be stored (touching ranges are merged) |
| `market_price_splits` | Split events the provider reported (also copied into `security_splits`, see [stock-splits.md](stock-splits.md)) |

These tables hold market data, not personal data. They are shared by all
users. Holdings, transactions and snapshots stay per user.

### Store-first lookups

`PriceHistoryService.getSeries(symbols, { from, to }, now)`:

1. reads the symbol's covered ranges;
2. asks the provider only for the dates outside it, one request per gap (a
   symbol held in two stretches years apart is stored as two ranges; the
   years between are never fetched). Gaps
   longer than `MARKET_PRICE_MAX_FETCH_DAYS` are fetched in parts. A gap made
   only of weekend days after the covered range is not fetched;
3. validates the response: symbol, a 3-letter currency, `AS_TRADED` closes,
   positive decimal closes inside the requested dates, in order, no
   duplicates. A response that fails is not stored;
4. upserts the closes and splits, and extends the covered range, in one
   transaction;
5. answers from the database.

Lookups for the same symbol are serialised in the process, so concurrent
callers (the job, a dashboard, an as-of request) share one provider request.
Writers in different processes take a Postgres advisory lock per series.
Upserts are idempotent, so a retry or a race never duplicates rows.

**Which dates count as covered.** Below the covered range, every fetched day
counts: later sessions exist, so a day with no close had no session. Above it,
the range only extends to the last close returned, or to days more than 7 days
old. So a recent weekday with no close yet (late data, or a holiday not yet
confirmed) is asked about again on the next lookup, and only those few days
are requested.

**Finalised closes are immutable.** A covered close is never fetched again. To
pick up a provider correction, call `POST /api/valuations/recompute
{ fromDate, refreshPrices: true }` (MCP `request_valuation_recompute`). This
shrinks the covered range of the symbols in scope back to `fromDate`, so the
next lookup fetches them again. Any close that comes back different replaces
the stored one, sets `revised_at`, and queues a re-valuation from that date
for **every account of every user** that traded the symbol. Nobody else's data
is shown. Their snapshots are just recomputed.

**Provider outage.** Whatever is stored is used, and the result carries a
warning (logged; shown in `GET /api/valuations/as-of` `warnings`). Dates the
store doesn't cover get `PRICE_PENDING` or `MISSING` and are re-tried. With
nothing stored, the symbol has an error and its holdings are `MISSING`.

## Yahoo caveats and how they are handled

- **Quote vs close.** Quotes are `LAST` (possibly intraday) or `CLOSE`. The
  adapter returns a daily close only once the session's scheduled close plus 30
  minutes has passed in the exchange's time zone, so an intraday price is never
  stored as a close.
- **Time zones and trading dates.** The trading date is the bar's date in the
  exchange time zone that Yahoo reports (`exchangeTimezoneName`). It is never
  the UTC date. Half-day sessions are not known, so `close_time` is the regular
  close.
- **Weekends and holidays.** There is no holiday calendar. A weekday with no
  close is `PRICE_PENDING` until a later session shows it was a holiday
  (`NON_TRADING_DAY`). See [valuations.md](valuations.md).
- **Adjusted vs unadjusted.** Yahoo's daily `close` is adjusted for **every
  split up to today**, not for dividends. For example, NVDA's 2024-06-03 close
  is reported as 115.00, though it traded at 1150.00 before the 10:1 split.
  Multiplying that by the ledger's recorded quantities would be wrong. The
  adapter requests the split events too (`events=split`). If the range ends
  before today, it makes a second, coarse request (`interval=3mo`) for the
  splits after it. It then multiplies the adjustment back out. Stored closes
  are `AS_TRADED`: the price that actually traded on each date. `adjclose`
  (dividend-adjusted) is never used.
- **Splits while held.** Splits are modelled (see
  [stock-splits.md](stock-splits.md)). The splits Yahoo reports are copied into
  `security_splits` (verified rows win), and valuations convert each date's
  holdings to that date's share basis, so the as-traded close values them
  correctly.
- **Floating-point noise.** Yahoo's bar closes are single-precision floats
  (121.79 arrives as 121.79000091552734). They are rounded to 7 significant
  digits before they are stored as `numeric`.
- **Minor units.** `GBp`/`GBX` (pence), `ZAc` and `ILA` are converted to GBP,
  ZAR and ILS.
- **Legacy rows.** Closes stored by earlier versions were split-adjusted. The
  migration marks them `adjustment = 'SPLIT_ADJUSTED'`. They are never read
  back, and the next lookup replaces them. Any value that changes re-values
  the affected snapshots.

## Historical FX

Valuation history and as-of valuations convert to a `baseCurrency` at each
date's own FX close, from the same price store. The pair uses Yahoo's symbol,
`{FROM}{TO}=X` (e.g. `USDAUD=X` is AUD per USD), and its close on or before the
date (up to `VALUATION_MAX_CARRY_DAYS` earlier) is used. The rate, its date
and its source are listed in `totals.converted.rates`. If a currency has no
usable rate for a date, `converted` is `null` and
`totals.conversionUnavailable` says why. Money never falls back to today's rate
or a constant. Passing `fxRates` uses those constant rates for every date
instead, labelled `policy: CONSTANT`.

The dashboard's current totals still use the latest rate (`getFxRate`), with
its `asOf`. Only the history uses daily closes.

## Testing

- Offline tests stub the provider: `src/price-history.e2e.spec.ts` (cache hit
  and miss, partial ranges, concurrency, recent and holiday days, outages,
  corrections, splits, as-of vs snapshots, backdated trades, historical FX,
  stale quotes, REST/MCP parity, migration down/up),
  `yahoo-price.provider.spec.ts` (parsing, split reversal, retry flags) and
  `throttled-price.provider.spec.ts`.
- Live smoke test, opt-in only. It calls the real Yahoo endpoint, so it is
  never run in CI:

  ```bash
  cd apps/backend && MONEY_LIVE_YAHOO=1 npx jest src/yahoo-live.e2e.spec.ts
  ```

  It checks a real quote (no mock label), dated closes and historical FX from
  Yahoo, and that a second lookup of the same history makes no request.

### Mock ticker suffixes

The mock provider reserves two ticker suffixes, so a running development
server can show price edge cases without a test hook. The
[synthetic seed data](seed-data.md) uses them.

| Suffix | Behaviour | Shows |
|---|---|---|
| `.MOCKMISSING` (e.g. `DELIST.MOCKMISSING`) | Unknown symbol: no quote, no closes | A missing price (valued at cost) |
| `.MOCKSTALE` (e.g. `GRWTH.MOCKSTALE`) | Latest quotes always fail; daily closes work | A stale price (the last stored close) |

## Operations

- To see what is stored, run `SELECT * FROM market_price_series ORDER BY symbol`.
  It shows the covered range and the last fetch for each symbol.
- To re-fetch a range, call `POST /api/valuations/recompute { fromDate,
  refreshPrices: true }`. The job does the fetch on its next run.
- Warnings about rate limiting (`HTTP 429`) or outages show up in the logs
  (`PriceHistory`, `MarketPrices`). The job re-tries `PARTIAL` days for
  `VALUATION_RECHECK_DAYS`.
