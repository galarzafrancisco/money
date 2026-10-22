# @money/backend

Money's backend: personal investment tracking exposed as a **REST API** (`/api`)
and an **MCP server** (`/mcp`, Streamable HTTP). Both call the same services, so
the business rules live in one place.

Money **only records and tracks**. Deposits, withdrawals, FX conversions,
transfers between accounts, buys, sells and dividends are records of things that happened elsewhere. They are
entered by hand or sent by external automation. Nothing here contacts a bank or
broker, moves money or places trades. Market-price lookups are the only outbound
calls.

| Doc | Contents |
|---|---|
| [docs/data-model.md](docs/data-model.md) | Architecture, tables, how derived state is computed, edit and delete semantics |
| [docs/api.md](docs/api.md) | REST endpoints, MCP tools, errors |
| [docs/categories.md](docs/categories.md) | Subaccounts (buckets), user-defined categories, roll-up and category reports, FX policy |
| [docs/dashboard.md](docs/dashboard.md) | Portfolio dashboard: asset classes (cash, shares, super), categories, ticker concentration, display currency and FX policy, valuation quality |
| [docs/transfers.md](docs/transfers.md) | Transfers between accounts: linked legs, FX, atomicity, edits, deletion and reversal |
| [docs/lot-selection.md](docs/lot-selection.md) | Purchase lots, specific identification and FIFO for sales, split allocations, precision, edit rules, UI contract |
| [docs/web-auth.md](docs/web-auth.md) | Browser sign-in through Taico: BFF sessions, cookies, CSRF, renewal, sign-out, web app contract, Taico setup |
| [docs/accounting-assumptions.md](docs/accounting-assumptions.md) | Australian cost base, lots, FX and dividend assumptions, plus open questions |

## Architecture

```
REST controllers ─┐
                  ├─► services (validation with zod, business rules) ─► repositories (TypeORM, user-scoped) ─► Postgres
MCP tools ────────┘              │
                                 └─► ledger engine (pure: replays transactions into balances, lots, gains)
                                 └─► MarketPriceProvider port ─► mock | yahoo
```

- **Controllers and MCP tools are adapters only.** They take the user from the
  validated token and pass input through. The services parse input with zod
  schemas, and the MCP tools use those same schemas as their input schemas.
- **Repositories** take the owning user's ID on every method, and every query
  filters on it.
- **The ledger engine** (`src/ledger`) is pure and has no I/O. Cash, lots,
  holdings, cost bases, realized gains and dividend totals are always derived
  from the transactions; they are never stored.

## Authentication

Authentication is federated to Taico through the published [`@taico/auth`](https://www.npmjs.com/package/@taico/auth) package.
Money has no logins. Every `/api` and `/mcp` request needs a Taico access token
that passes these checks:

- its signature matches Taico's JWKS;
- its `iss` is `TAICO_ISSUER`;
- it has not expired;
- its audience is the resource being called. A token for `…/mcp` is refused on
  `…/api` and the other way round.

The user is identified by the token's `(iss, sub)` only, and a Money user row is
created on first use. Nothing in a request body, query string or tool argument
can choose the user. Another user's account or transaction answers **404**, not
403, so its existence isn't revealed.

The web app does not handle tokens. It signs in through `/auth/login` (Authorization Code +
PKCE at Taico, run by this backend) and calls `/api` with an HttpOnly session cookie plus
`X-CSRF-Token`. The backend turns the cookie into the session's access token, and the same JWT
checks above then run. `/mcp` accepts bearer tokens only. Design, contract and Taico setup:
[docs/web-auth.md](docs/web-auth.md).

Protected-resource metadata (RFC 9728) is served at
`/.well-known/oauth-protected-resource/mcp` and `/…/api`, and points clients at
`TAICO_AUTHORIZATION_SERVERS`.

## Running

```bash
npm install
npm run dev          # from the repo root: watches the backend
npm run build        # nest build → apps/backend/dist
npm start            # node apps/backend/dist/main.js
```

Without `DATABASE_URL`, the backend uses **embedded PGlite** (Postgres compiled to
WASM) in `apps/backend/.data/pglite`. You don't need a database server for
development, and it runs the same migrations and SQL as production. Production
refuses to start without `DATABASE_URL`.

Migrations run on startup; the schema is never synchronized from entities. To run
them by hand: `npm -w @money/backend run migration:run` (with `DATABASE_URL` set).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4180` | HTTP port |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | Public URL. Token audiences are `$PUBLIC_BASE_URL/mcp` and `$PUBLIC_BASE_URL/api`. |
| `NODE_ENV` | `development` | `production` requires `DATABASE_URL`, `TAICO_ISSUER` and `SESSION_ENCRYPTION_KEY` |
| `DATABASE_URL` | unset → PGlite | Postgres connection string |
| `DATABASE_SSL` | `false` | `true` to require TLS (certificate verified) |
| `DATABASE_POOL_MAX` | `10` | Connection pool size |
| `PGLITE_DATA_DIR` | `.data/pglite` | PGlite directory when `DATABASE_URL` is unset (`memory://` for throwaway) |
| `TAICO_ISSUER` | `http://localhost:3000` | Expected `iss` of access tokens |
| `TAICO_JWKS_URL` | `$TAICO_ISSUER/.well-known/jwks.json` | Where Taico's signing keys are |
| `TAICO_AUTHORIZATION_SERVERS` | `$TAICO_ISSUER` | Comma-separated authorization servers advertised in resource metadata |
| `TAICO_WEB_SERVER_ID` | `money-api` | Taico registry entry (URL `$PUBLIC_BASE_URL/api`) used for browser sign-in |
| `TAICO_WEB_CLIENT_ID` | client metadata URL on https, else unset | Money's client_id for browser sign-in ([docs/web-auth.md](docs/web-auth.md)) |
| `WEB_APP_URL` | `$PUBLIC_BASE_URL` | Web app base URL; post-login redirects stay under it |
| `SESSION_ENCRYPTION_KEY` | random per process (dev) | 32 bytes base64; encrypts session tokens at rest. Required in production. |
| `WEB_SESSION_IDLE_MINUTES` / `WEB_SESSION_MAX_HOURS` | `720` / `168` | Browser session idle and absolute expiry |
| `MARKET_PRICE_PROVIDER` | `mock` | `mock` or `yahoo` (see below) |
| `MARKET_PRICE_CACHE_SECONDS` | `300` | How long a quote is reused |
| `VALUATION_JOB_ENABLED` | `true` (`false` in tests) | Run the daily valuation job in this process |
| `VALUATION_JOB_INTERVAL_MINUTES` | `60` | How often the job looks for due dates |
| `VALUATION_SETTLE_HOUR_UTC` | `6` | Date D is valued once D+1 at this UTC hour has passed |
| `VALUATION_BACKFILL_DAYS` / `VALUATION_RECHECK_DAYS` / `VALUATION_MAX_CARRY_DAYS` / `VALUATION_MAX_DAYS_PER_RUN` | `366` / `7` / `7` / `400` | See [docs/valuations.md](docs/valuations.md) |

## Market prices

Prices come through the `MarketPriceProvider` port (`src/market-prices/market-price.port.ts`).

- **`mock`** (default): **made-up prices.** Each price is a stable hash of the
  symbol, and the currency is guessed from the suffix (`.AX` → AUD, else USD).
  Every quote carries `source: "mock"` and `isMock: true`. Use it for
  development and tests only.
- **`yahoo`**: Yahoo Finance's chart endpoint. It is free, needs no key, covers
  the ASX (`VAS.AX`) and US listings, and reports the currency. It is
  **unofficial**: there is no SLA and no published terms for this use, it may
  rate-limit or change without notice, and prices may be delayed. That is why
  it is opt-in. Stooq's free CSV endpoint was also checked and no longer
  answers. Keyed free tiers (Alpha Vantage, Finnhub, Twelve Data) can be added
  as further adapters behind the same port.

A holding is only valued when the quote's currency matches the currency it was
traded in; otherwise `priceError` says why.

## Daily valuations

A scheduled in-process job materialises each user's holdings, valued at each
trading day's market close, for value-over-time charts. It backfills missed
dates, re-values from the date of backdated trades, and flags non-trading,
pending and missing prices explicitly. Read it with `GET /api/valuations` or
the `get_valuation_history` tool. Run one pass by hand with
`npm -w @money/backend run valuations:run`. Scheduling, price statuses,
recovery and provider limitations are in
[docs/valuations.md](docs/valuations.md).

## Tests

```bash
npm -w @money/backend test
```

- Unit tests: three-of-four trade math, two-of-three dividends and FX, transfer
  amounts, ledger
  replay (cash and FX flows, FIFO and specifically identified lots, split
  allocations and their reconciliation, cost bases, dividends, violations, the
  12-month test), Yahoo adapter (quotes and daily closes), market time zones,
  historical positions and close selection, user identity mapping.
- End-to-end tests over HTTP on both interfaces: token validation (missing,
  foreign key, wrong issuer, expired, wrong audience, cross-resource), the full
  investment flow, edit and delete semantics, transfers (atomicity, FX, edits,
  isolation), daily valuations (historical quantities, idempotency, holidays,
  pending and missing prices, backdated edits, isolation), lot selection
  (the 15/25 split, edits, deletes, backdating, FIFO compatibility, valuation
  history, isolation), concurrency tests, and
  **cross-user isolation on every REST route and MCP tool**.

Each e2e test file starts its own in-memory PGlite in a child process, reached
over the Postgres protocol. Set `TEST_POSTGRES_URL` (an admin URL to a real
Postgres server) to run the same suite against Postgres instead; each file then
creates and drops its own database.
