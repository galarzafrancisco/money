# Synthetic seed data

Made-up users, accounts and activity for developing and testing Money without
real financial data. Every name, amount and identity is fictional. Prices come
from the **mock** market-price provider. Nothing here is a real portfolio,
and none of it is tax advice.

The dataset lives in `src/seed/seed-dataset.ts`. The runner (`src/seed/seed-runner.ts`)
writes it through the same services REST and MCP use (`AccountsService`,
`CategoriesService`, `TransactionsService`, `TransfersService`,
`TaxLedgerService`, `TaxAssetsService`), so every
record passes the usual zod parsing, business rules and ledger replay. It never
inserts rows directly. The seed code is not part of `AppModule`, and no HTTP
route or MCP tool can reach it.

## Commands

Run these from the repository root. Stop `npm run dev` first when it uses the
default embedded PGlite, because only one process can open that database.

```bash
npm run seed                                # reset and seed every synthetic user, then run valuations
npm run seed -- --as <your-taico-subject>   # also seed Alex's dataset into your own local identity (for the UI)
npm run seed -- --anchor 2026-06-30         # date the activity relative to this day (default: today, UTC)
npm run seed -- --no-valuations             # skip the valuation run
npm run seed:reset                          # delete the synthetic users only
npm run seed:reset -- --as <your-subject>   # also delete the records seeded into your identity
npm run seed -- --help
```

`npm run seed` is a reseed: it deletes the synthetic records first, so running
it twice gives the same data (database IDs aside). With the same `--anchor`, it
also gives the same dates.

Expected output (anchor 2026-10-22):

```
Seeded: http://localhost:3000 / money-seed-alex (alex): 6 accounts, 4 categories, 36 transactions, 5 transfers, 4 tax items, 1 tax assets
Seeded: http://localhost:3000 / money-seed-blair (blair): 2 accounts, 1 categories, 4 transactions, 1 transfers
Seeded: http://localhost:3000 / money-seed-empty (empty): 0 accounts, 0 categories, 0 transactions, 0 transfers
Edge cases: http://localhost:3000 / money-seed-edge (edge): 8 accounts, 1 categories, 9 transactions, 0 transfers
Valuations for money-seed-alex: 345 days (0 partial)
Valuations for money-seed-blair: 185 days (0 partial)
Valuations for money-seed-empty: 0 days (0 partial)
Valuations for money-seed-edge: 120 days (120 partial)
```

## Safeguards

Seeding is for development and tests only. The CLI refuses to run (see
`src/seed/seed-guard.ts`) when:

- `NODE_ENV=production`;
- `DATABASE_MODE=memory`, whose database lives inside the server process;
- `DATABASE_URL` points to a host other than `localhost`, `127.0.0.1` or `::1`.
  If it really is a development database (for example a Docker Compose service
  name), set `SEED_ALLOW_NON_LOCAL_DATABASE=true`;
- `MARKET_PRICE_PROVIDER` is not `mock` (the default). The trade prices are
  chosen to match mock closes.

It also protects records that are not synthetic:

- Synthetic identities have subjects starting with `money-seed-`, which no
  Taico user has. Their emails end in `.invalid`.
- Every seeded account and category description, and every seeded tax item
  and tax asset's notes, starts with `[synthetic seed]`.
- Before it seeds or resets an identity, the runner checks that **every**
  account, category, tax item and tax asset of that identity carries the marker. If any does not,
  it refuses and touches nothing. `--as` therefore only works on an identity
  with no records, or with records it seeded itself.
- Resetting a `money-seed-*` identity deletes its user row (records and
  valuations cascade). Resetting an `--as` identity deletes its records and
  valuations but keeps its user row and sign-in sessions.

## Identities and authentication

The users are scoped like everyone else: by `(issuer, subject)`, with the
issuer from `TAICO_ISSUER` (default `http://localhost:3000`). Authentication is
not weakened, and there is no seed-only login.

- **Tests** sign tokens for the `money-seed-*` subjects with the test JWKS
  (`test.token({ subject: 'money-seed-alex' })` in `src/test-support/test-app.ts`),
  for REST and for MCP (`audience: config.auth.mcpResourceUrl`).
- **The UI and your own MCP client** sign in through Taico, so they see the user
  you signed in as, not a `money-seed-*` one. To see seeded data, sign in once,
  open `/api/me`, copy `subject`, then run `npm run seed -- --as <subject>`.

## Users

| Subject | Purpose | What it covers |
|---|---|---|
| `money-seed-alex` | Default, coherent | Bank with two buckets (subaccounts), custom categories, AUD/USD cash, a cross-currency transfer with a fee, an FX conversion, ASX and US buys, FIFO and specific-lot sells, fees, dividends with withholding and franking credits, superannuation, NVDA concentration |
| `money-seed-blair` | Default, coherent | A second user whose account names, category name and one ticker (VAS.AX) match Alex's, with different amounts, so a leak between users is easy to spot |
| `money-seed-empty` | Default | A user with nothing: empty states |
| `money-seed-edge` | **Edge cases only** | Missing price, stale price, a currency with no FX rate, a sold-out holding with a later dividend, fractional shares, an account with no transactions, 5-level nesting, an unused category |

Edge cases are kept in their own user so the default users stay coherent.

### Alex: expected results

Activity spans 360 days before the anchor to 10 days before it.

| Account | Type | Parent / category | Cash | Holdings |
|---|---|---|---|---|
| Everyday Bank | CASH | | 17,342.00 AUD | |
| Emergency Fund | CASH | Everyday Bank / `emergency-fund` | 15,000.00 AUD | |
| Term Deposit 1 | CASH | Everyday Bank / `term-deposits` | 10,350.00 AUD | |
| ASX Broker | INVESTMENT (AUD) | | 5,487.60 AUD | VAS.AX 35, VGS.AX 15, BHP.AX 15, CBA.AX 30 |
| US Broker | INVESTMENT (USD) | | 2,132.18 USD, 0.00 AUD | IVV 25, NVDA 25, PLTR 30 |
| Super Fund | SUPERANNUATION | | 966.40 AUD | VDHG.AX 30 |

- Holding categories: VAS.AX, VGS.AX and IVV are `broad-market-etf`; NVDA and
  PLTR are `alpha-high-risk`.
- VAS.AX: lots of 30 and 5 remain, because the specific-lot sale took 5 shares
  from the second lot. Cost base 15,855.25 AUD.
- CBA.AX: FIFO sold 20 of 50, leaving a cost base of 1,671.30 AUD.
- The transfer to the US broker converts 20,000 AUD at 0.65 with a 10 AUD fee.
- Tax ([tax.md](tax.md)): a conference ticket (899.00, 50 % intended, linked to
  its bank withdrawal 45 days before the anchor, with a receipt URL), home
  internet (960.00 at 20 %), a confirmed tax agent fee and a donation, all
  manual except the ticket. An AI workstation (6,249.00, paid from the bank 220
  days before the anchor, first used 7 days later) depreciates by diminishing
  value over a 4-year effective life at 80 % work use. With anchor 2026-06-30
  everything falls in FY 2025-26, and the workstation's first year is
  214/365 days: decline 1,831.90, deduction estimate 1,465.52. Evidence URLs
  point at `example.invalid`. Item and asset notes carry the seed marker, and
  the safety check covers them too.

### Blair: expected results

| Account | Category | Cash | Holdings |
|---|---|---|---|
| Everyday Bank | | 4,000.00 AUD | |
| ASX Broker | `broad-market-etf` (account) | 611.64 AUD | VAS.AX 12, A200.AX 4 |

### Edge: expected results

| Account | Cash | What to look for |
|---|---|---|
| Edge Broker (USD) | 2,214.05 USD | `DELIST.MOCKMISSING` 10 (no price: valued at cost, `COST_FALLBACK`), `GRWTH.MOCKSTALE` 5 (stale close after a valuation run), VOO 0.125 (fractional), XYZ sold out with a dividend after the sale |
| Swiss Cash (CHF) | 1,000.00 CHF | CHF has no mock FX rate: the dashboard lists it under missing FX and valuations are `PARTIAL` |
| Empty Account | none | No transactions |
| Level 1 … Level 5 | 100.00 AUD in Level 5 | The deepest nesting allowed |

The missing and stale prices use two reserved ticker suffixes in the mock
provider ([market-prices.md](market-prices.md#mock-ticker-suffixes)).

## Prices, FX and valuations

- Trade prices are each symbol's mock base price, or within the mock's ±5%
  daily swing (a unit test checks this). Cost bases, closes and value-over-time
  charts therefore stay plausible.
- Mock FX rates come from the mock provider's fixed table (AUD 0.65 USD, …).
- After seeding, the CLI runs the valuation job for each seeded user, so the
  value-over-time history is filled in. Dates are offsets from the anchor,
  so the history stays inside `VALUATION_BACKFILL_DAYS` (default 366).
- Balances, holdings and cost bases do not depend on the anchor. Market values
  do, because mock prices vary by date.

## Tests

`src/seed/seed.e2e.spec.ts` seeds all users into the test app (PGlite or
`TEST_POSTGRES_URL`) and checks the documented balances, holdings and cost
bases, the anchor dates, isolation on REST and MCP (another user's account is
`404`), the edge cases on the dashboard, reseeding, `--as` seeding and reset, and
the refusal to touch non-synthetic records. `src/seed/seed-guard.spec.ts`
covers the safeguards, the mock suffixes and the dataset's synthetic identities.

Other feature tests keep their own small fixtures. Use the seed dataset when a
test needs a realistic multi-account portfolio.

## Dependencies

The dataset uses features that are already on `main`: accounts and subaccounts,
categories and holding categories, transfers (including cross-currency),
specific-lot sells, dividends with withholding and franking, and daily
valuations. When a migration or feature changes the shape of these inputs,
update `seed-dataset.ts` together with it. The e2e test fails if the dataset no
longer replays to the documented results.
