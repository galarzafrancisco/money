# Portfolio dashboard

`GET /api/dashboard` and the MCP tool `get_dashboard` return one view of
everything you track. It shows total assets in a display currency, split by
asset class, category, top-level account and ticker. The web app's Dashboard
(`/dashboard`) renders this response and does no arithmetic of its own.

Figures are personal tracking aids, not financial or tax advice.

## Where the numbers come from

The dashboard reuses the valuation items of the accounts and categories reports
(`ReportsService.valuationContext`). There is one item per cash balance (one
currency in one account) and one per holding (one symbol in one account).
Holdings are valued at the latest market price. Without a usable price, a
holding is valued at its cost base and flagged. Every breakdown below is a
**partition** of the same items, so each adds up to the total and nothing is
counted twice:

| Breakdown | Rule |
|---|---|
| `assetClasses` | `super` if the account, or any ancestor, is `SUPERANNUATION`; else `shares` for holdings and `cash` for cash |
| `categories` | The effective category ([categories.md](categories.md)): the holding's own, else the account's, else the nearest ancestor's, else Uncategorized. Every category you created is listed, even empty ones |
| `accounts` | Top-level accounts, each including all its subaccounts (the report's `rolledUp`) |
| `shares.tickers` | Share-class holdings grouped by symbol across accounts. `positions` lists the account each one is in |

## Daily change

`dailyChange` is the change in total tracked assets since the previous
session close, shown on the web Dashboard as e.g. `-12K` (red for a loss,
green for a gain). It is the **price movement of holdings**:
`quantity × (latest price − previous close)` for every holding valued at a
market price, converted to the display currency at the same rates as the
totals. `percent` is that change over the same holdings' value at the
previous close.

- Cash (including deposits, withdrawals and imported Up balances) is not a
  market move, so it is not part of the change.
- A holding with no market price, no previous close, a currency mismatch or a
  split since the previous close is left out and counted in
  `holdingsExcluded` (`complete: false`).
- With a missing FX rate, `converted` and `percent` are `null`; `byCurrency`
  still gives each currency's change.
- Previous closes come from the shared price store (`PriceHistoryService`).

## Superannuation

`SUPERANNUATION` is an account type. Everything in a super account or in its
subaccounts is super, whatever form it takes:

- **Fund balance.** Record it as cash: contributions as deposits, and
  investment returns, fees and tax as deposits or withdrawals of the
  difference. This keeps the ledger as the source of truth.
- **Listed shares held in the fund** (e.g. a member-direct option). Record them
  as buys in the super account, or in a subaccount of it. They count as super,
  not in the share portfolio or ticker concentration. The daily valuation
  history still values them, because it covers every share holding.

Because there is no separate "statement balance" record, a super fund's value
is always the sum of its own items. A recorded balance can never stack on top
of the holdings it represents.

## Display currency and FX policy

`displayCurrency` defaults to `AUD`, and the web app toggles between AUD and
USD. It only changes how figures are shown. Recorded transactions and the
per-currency figures (`byCurrency`) are never changed.

Each currency held other than the display currency needs a rate (units of
display currency per 1 unit):

1. A manual rate from `fxRates` (`USD:1.52` in a query string, an object over
   MCP) wins. It is reported with `source: "manual"`.
2. Otherwise the market-price provider is asked (`MarketPriceProvider.getFxRate`).
   Yahoo uses the pair `USDAUD=X`. The mock provider gives fixed made-up rates
   with `isMock: true`. The rate is reported with `source: "market"`, the
   provider and its `asOf` time.
3. If any currency still has no rate, it is listed in `fx.missing`, and **every
   converted figure and percentage is `null`**. A partial total is never
   presented as the whole, and per-currency figures are still given. The web app
   then asks for a manual rate.

One rate per currency is used for the whole response, as of the request. It is
not a historical rate.

## Percentages and denominators

Percentages are decimal strings with 2 dp, computed by the backend from
converted values. They are `null` when conversion is incomplete or the
denominator is zero.

- `assetClasses[].percentOfTotal`, `categories[].percentOfTotal` and
  `accounts[].percentOfTotal` divide by `total`.
- `assetClasses[].accounts[].percentOfClass` divides by that asset class.
- `shares.tickers[].percentOfShares` divides by the share portfolio
  (`shares.totals`). `percentOfTotal` divides by all tracked assets.

## Valuation quality

Each holding gets a `priceStatus`:

| Status | Meaning |
|---|---|
| `MARKET` | A real price, at most `stalePriceDays` (5) days old |
| `STALE` | A real price older than that |
| `MOCK` | A made-up development price |
| `COST_FALLBACK` | No usable price (unknown, failed, or in a different currency), so valued at cost base |

A ticker shows the worst status among its positions. `valuation.status` is
`COMPLETE` only when no holding is `STALE` or `COST_FALLBACK` and every currency
was converted. Otherwise it is `PARTIAL`. Mock data is flagged separately by
`usesMockPrices`. `warnings` explains each gap in words.

The web app's "Share holdings over time" chart reads the daily valuation
history (`GET /api/valuations`, [valuations.md](valuations.md)). It converts
each day at that day's historical FX close, never today's rate. It leaves out
and counts any day without a rate, and notes days awaiting recomputation. It
covers share holdings only, so it is not total wealth.

A price served from the last known value because the provider is down has
`isStale: true` and is rated `STALE`; an FX rate in that state has
`isStale: true` and a warning. See [market-prices.md](market-prices.md).

## Isolation

Every query is scoped to the signed-in user (`(iss, sub)` of the token). Another
user's accounts, categories and holdings never appear. `dashboard.e2e.spec.ts`
covers this over REST and MCP.
