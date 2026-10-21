# @money/web

Money's web app: your accounts and subaccounts, what they hold, and forms to
**record** activity that already happened (deposits, withdrawals, currency
conversions, buys, sells with lot selection, dividends and transfers). Money
never moves money or places trades, and the UI says so.

React 19, Vite, React Router, TanStack Query and Vitest. The rules are in
[docs/ui/guidelines.md](../../docs/ui/guidelines.md), and reviewers check
[docs/ui/review.md](../../docs/ui/review.md).

## Running it

| Command | What it does |
|---|---|
| `npm run build` (repo root) | Builds everything. The backend then serves `apps/web/dist` at `/` (`src/web-app/serve-web-app.ts` in the backend) |
| `npm run dev` then `npm run dev:web` (repo root) | Backend on 4180, plus Vite on http://localhost:5173 with hot reload. Vite proxies `/api` and `/auth` to the backend (`MONEY_BACKEND_URL` overrides the target). Set `WEB_APP_URL=http://localhost:5173` on the backend so that sign-in returns to Vite |
| `npm -w @money/web test` | Vitest + Testing Library |
| `npm -w @money/web run typecheck` | `tsc` only. Vite does the build |

Signing in needs a Taico `money-api` entry that matches your backend URL. See
[web-auth.md](../backend/docs/web-auth.md#local-development). There is no
local login, mock sign-in or auth bypass.

## Structure

```
src/
├── app/        composition: session module, API client provider, shell, routes, error boundary
├── ui/         primitives and design tokens (no feature or backend imports)
├── features/
│   ├── accounts/      list, creation wizard, account layout, overview, subaccounts, settings
│   ├── transactions/  history, detail, lots, record-activity page and forms (incl. LotPicker)
│   ├── transfers/     transfer list and form
│   ├── categories/    category management and holding categories
│   └── shared/        error callout, page header, query keys, price provenance, currency lines
├── lib/decimal.ts     exact decimal-string formatting and comparison (BigInt, no floats)
└── test/              fixtures and render helpers
```

- **Backend access.** The app uses only the generated `@money/client`
  (`docs/architecture/api-clients.md`). `app/api.tsx` builds one client per
  session (`credentials: 'same-origin'` and the session's `X-CSRF-Token`).
  Each feature's `data.ts` wraps the client calls in React Query hooks.
  `run()` ends the session on 401 and refreshes the CSRF token once on
  `csrf_failed`.
- **Session.** Only `app/session.tsx` talks to `/auth/*` (`/auth/session`,
  `/auth/logout`, navigation to `/auth/login`). Those endpoints are not part of
  the REST resource, as `web-auth.md` explains. The browser holds only the
  HttpOnly cookie.
- **Navigation.**
  - The shell owns app-level navigation: Accounts and Categories, in a sidebar
    on desktop and a drawer on mobile.
  - An account declares its sections with `<InAppNav>`. They show as tabs on
    desktop and as a bottom bar on mobile.
  - Every section, filter and record type is in the URL, e.g.
    `/accounts/:id/record?type=SELL`.
- **Refreshing.** Every write invalidates what it changes: portfolio,
  transactions, lots, transfers and the accounts report of each affected
  account. Balances and holdings therefore refresh after each recorded
  activity.

## Financial data rules (how they are met)

- **No float maths.** Amounts stay strings. `lib/decimal.ts` only formats
  them and compares typed lot quantities exactly. Totals, gains, cost bases,
  allocations and the calculated field of a trade, dividend or conversion all
  come from the backend.
- **Any three of four, any two of three.**
  - Trade forms count which of quantity, price, fees and total are filled in
    and label the one "Money calculates this".
  - After saving, the form shows the backend's `calculatedField` and its value.
  - Dividends (gross, withheld, net), conversions and cross-currency transfers
    (sent, received, rate) work the same way with two of three.
- **Lot selection.**
  - The default is FIFO. "Choose lots" fetches
    `GET /api/accounts/:id/lots?symbol&asOf` and shows one input per open lot,
    with a running total.
  - The form can only be submitted when the total equals the sale quantity.
    `allocations` are sent in display order.
  - A `422 ledger_violation` shows the backend message and re-fetches the lots.
  - After a sale, the per-lot breakdown from
    `GET /api/transactions/:id/allocations` is shown with the backend's notes.
- **Currencies.**
  - Every amount shows its currency.
  - Per-currency totals are listed line by line and never added together.
  - A parent's figure is its rolled-up total, labelled "incl. subaccounts".
- **Provenance and tax.** Mock prices carry a "Mock price" badge, a missing
  price shows its error, and holdings valued at cost show the report's
  warnings. The backend's notes ("not tax advice", trade currency, no AUD
  conversion) are shown next to the figures.

## Tests

`src/**/*.test.ts(x)` render the whole app (`App` with a `MemoryRouter`), using
a stand-in session transport and a `vi.fn` stand-in for the generated client
(`test/render.tsx`). They cover:

- sign-in, `?authError`, 401 expiry and sign-out;
- the accounts tree and per-currency totals;
- the wizard: validation, review, conflict and success;
- account detail navigation into a sale's allocations, holding categories and
  lots;
- recording a buy (three of four), a sale from chosen lots (15 + 25 = 40), an
  over-allocation, a 422 lot re-fetch, a dividend, a deposit with a 400, an FX
  conversion and a transfer;
- categories, including deleting one that is still assigned.

The backend checks separately that real responses match the spec
(`apps/backend/src/openapi.e2e.spec.ts`).

## Known gaps

- **Editing.** Records can be viewed and deleted, but not edited yet
  (`PATCH /api/transactions/:id` and `/api/transfers/:id` exist). To correct
  one, delete it and record it again.
- **Not covered here.** Valuation history charts and category reports belong
  to the dashboards task (1fcae95c).
- **Not tried end to end.** No live sign-in has been done against Taico. The
  `money-api` registry entry and `SESSION_ENCRYPTION_KEY` are still
  outstanding (see docs/deployment.md).
