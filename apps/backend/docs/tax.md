# Tax ledger and depreciating assets

Money can remember things for an **Australian** tax return during the year:
an expense you plan to claim, income to declare, or an asset you use for work.
At tax time it shows each financial year's proposed claims, where they came
from, the evidence links you attached, and the estimated depreciation of your
assets.

> **Tracking aid, not tax advice.** Money records your *intent* (what you plan
> to claim and why) and *estimates* depreciation from inputs you give it. It
> never decides whether something is deductible or assessable, never looks up
> an ATO effective life, and never applies an instant asset write-off or
> low-value pool rule by itself. Confirm your treatment with the ATO's guidance
> or a registered tax agent. Money doesn't lodge anything.

Code: `src/tax/` (`tax-ledger.service.ts`, `tax-assets.service.ts`,
`tax-years.service.ts`, the pure `depreciation-math.ts`, `financial-year.ts`
and `tax-views.ts`). REST: `/api/tax/*`. MCP: the `*_tax_*` tools. Web:
**Tax** in the sidebar (`/tax`).

## Model

| Concept | What it is | Table |
|---|---|---|
| **Source fact** | Something that happened: a Money transaction, an imported Up transaction, an asset you own, or (with no transaction) the item itself | `transactions`, `up_transactions`, `tax_assets` |
| **Tax item** | One proposed position in one financial year: kind, category, amount, claim %, rationale, review status, and the amount actually claimed | `tax_items` |
| **Asset position** | An asset's estimated decline in value for one year (and any balancing adjustment). Derived from the asset, never stored | (computed) |
| **Asset year** | Per asset and year: work-use % override, review status, the amount actually claimed for the decline in value (`claimedAmount`) and, in a disposal year, for the balancing adjustment (`balancingClaimedAmount`), note | `tax_asset_years` |
| **Source link** | Item or asset → Money or Up transaction. A reference, never a copy | `tax_source_links` |
| **Evidence link** | Labelled URL to a receipt, invoice, calculation or statement | `tax_evidence_links` |
| **Return** | Per financial year: `PREPARING`, `FILED` or `AMENDING`, notes | `tax_returns` |
| **Filing** | Immutable snapshot of every position and total as lodged (version 1 `ORIGINAL`, then `AMENDMENT`s) | `tax_return_filings` |

A source can give rise to positions in several years. An asset gives one per
year of its schedule. A transaction can also back items in different years
(with `allowShared`).

### Financial years

Australian financial years run 1 July to 30 June. The API writes them as
`"2026-27"` (1 July 2026 to 30 June 2027). It also accepts `"FY2026-27"`,
`"2026/27"`, `"2026-2027"` and the start year as a number (`2026`). An item's
`taxYear` defaults to the year of its `date`, and without a date to the
current Australian year (Australia/Sydney). The 30 June / 1 July boundary is
tested both ways. An explicit `taxYear` that doesn't contain the date is kept
and flagged `outside-year` (for example a prepayment).

### Tax items

- `kind`: `DEDUCTION` (default), `INCOME`, `OFFSET` or `OTHER`, so the ledger
  isn't limited to deductions.
- `category`: any lower-case slug (`"Self education"` becomes
  `self-education`). `GET /api/tax/categories` (`list_tax_categories`) lists
  suggestions. Slugs aren't a fixed list.
- `amount`: the full source amount, before the claim %. Leave it empty to use
  the linked transactions instead (their absolute amounts in the item's
  currency; `amountSource: "linked"`). That lets you record something before
  it clears and link it later without typing the figure twice.
- `claimPercent` (0-100, default 100) is your intent.
  `proposedAmount = amount × claimPercent`, rounded to cents. It is derived and
  never stored.
- `status`: `TO_REVIEW` (default), `CONFIRMED` or `EXCLUDED`.
- `claimedAmount`: what you actually put on the lodged return. It is kept
  apart from the proposal, so intent and outcome can differ.
- `rationale` and `notes`: your words, for example "relates directly to my
  current work". Not a determination.

**Gaps** are listed on every item and position: `needs-review`,
`no-evidence`, `no-transaction` (manual or not matched yet), `no-amount`,
`not-aud`, `currency-mismatch`, `shared-transaction`, `outside-year`,
`removed-transaction` (Up deleted it). An `EXCLUDED` item shows no gaps.

### Links and double counting

`POST /api/tax/links` (`link_tax_transaction`) links an item **or** an asset
to a Money transaction **or** an Up transaction. Everything is user-scoped:
another user's item, asset or transaction answers `404`. Linking the same pair
twice is a no-op. Unlinking or deleting an item never touches the
transaction. If the transaction is deleted, the link goes with it and the item
shows `no-transaction` again.

To keep a purchase from being counted twice:

- A transaction linked to an **asset** can't be linked to an **item**, and the
  other way round (`409 conflict`, `details.linkedTo`). An asset's purchase is
  claimed through its depreciation, never also as an expense. `allowShared`
  doesn't override this.
- A transaction already linked to another item needs `allowShared: true`, for
  example one invoice split over two claims (and likewise for two assets).
  Both then show `shared-transaction` on every position they produce, in every
  year, and the year summary warns about it.

These checks are serialized per source transaction: each link write takes a
transaction-scoped advisory lock on the transaction it links (after its row
locks; see the lock order in [data-model.md](data-model.md#lock-order)), so two
concurrent requests linking the same transaction to an item and to an asset
can't both pass the check. One gets `409`.

### Evidence

Evidence is a list of labelled `http(s)` URLs (`kind` `RECEIPT`, `INVOICE`,
`CALCULATION`, `STATEMENT` or `OTHER`). There are no uploads, no file storage
and no receipt parsing. Keep documents wherever you already keep them and link
them.

## Depreciating assets

An asset records `cost`, `acquiredOn`, `firstUsedOn` (first used or installed
ready for use), `method`, your `effectiveLifeYears` or `ratePercent`,
`defaultUsePercent` (work/business share), `ownership` (your words on who owns
and uses it), payment links and evidence. You can also record `disposedOn` and
`disposalProceeds`. The schedule is derived from these inputs on every read.

### Calculation (`depreciation-math.ts`, rules `au-decline-in-value/2026.1`)

For each financial year from the year of first use:

- **Days held**: from `firstUsedOn` (first year) or 1 July, to 30 June or the
  disposal date, both counted. A year has 365 days, or 366 when it contains
  29 February.
- **Rate**: `ratePercent` if given, else 100 % ÷ life (prime cost) or
  200 % ÷ life (diminishing value).
- **Prime cost**: cost × rate × days held ÷ days in year.
- **Diminishing value**: opening value × rate × days held ÷ days in year.
- **Immediate**: the full cost in the first year of use. This is only your
  assertion that it qualifies (e.g. a low-cost item). Money doesn't check.
- Each year is rounded to cents (half up) and capped at the remaining value.
  The schedule ends when the asset is written off, at disposal, or at the
  horizon (`throughYear`, default: when a prime-cost write-off would finish,
  the disposal year, or the current year, whichever is latest).
- **Work use**: the asset declines in full every year. The estimated
  deduction is decline × that year's use % (`PUT
  /api/tax/assets/:id/years/:taxYear` with `usePercent`, else the default),
  and the rest is `privatePortion`. Changing one year's use % never changes
  another year's figure.
- **Disposal**: in the disposal year, decline runs to the disposal date, then
  the balancing adjustment = termination value − adjustable value. Positive is
  an estimated assessable amount (an `INCOME` position), negative an estimated
  deduction. Both are scaled by work use. If the asset was already written off
  in an earlier year (e.g. `IMMEDIATE`, or prime cost run to zero), the
  schedule skips the empty years in between and adds one row for the disposal
  year: no decline, an adjustable value of 0, and the balancing adjustment on
  the full termination value. That year's summary then has only the balancing
  adjustment position.
- **What was actually claimed**: a disposal year can have two positions, the
  decline in value and the balancing adjustment, and each takes its own
  actual figure: `claimedAmount` for the decline, `balancingClaimedAmount`
  for the adjustment (a positive amount; whether it was returned as income or
  claimed as a deduction follows the position's kind). Each is refused (400)
  in a year with no position for it to land on, e.g. `claimedAmount` in a
  disposal-only year after a write-off.

Each row carries `workings`, a sentence showing the numbers, so you can check
it by hand. The output records `rulesVersion`. Changing the formulas means a new
version, and filed snapshots keep the version they used.

Not modelled (on purpose, for now): low-value and software development pools,
the instant asset write-off thresholds, cost changes after acquisition (second
element of cost), split ownership, roll-over relief, and the ATO effective-life
tables. Enter what applies to you, for example the rate the pool would use, and
note it in `notes`.

## Years, filing and amendments

`GET /api/tax/years/:taxYear` (`get_tax_year_summary`) returns the year's
positions (items plus asset depreciation and balancing adjustments), totals
per kind and per category (`proposed` leaves out `EXCLUDED`, `confirmed`
counts `CONFIRMED` only, `claimed` sums `claimedAmount`), gap counts,
warnings and filing history. Totals stay per currency. A non-AUD position is
flagged, never converted. `GET /api/tax/years` lists every year that has
something, plus the current one.

`GET /api/tax/years/:taxYear/report` (`get_tax_year_report`) returns a
copyable Markdown summary and a CSV with one row per position. Add `?version=1`
for a filed version.

For a `FILED` year the summary answers with the latest filing, not with a
recomputation: `basis: "FILED"` and `filedVersion` say so, and `positions`,
`totals` and `gaps` are the snapshot's. What the live records give now is kept
apart under `live` (positions and totals), and `drift` lists every difference
from the filing: positions `added` or `removed`, and `changed` ones with the
`fields` that differ (figures such as `amount` or `proposedAmount`, or the
supporting `sources`, `evidence`, `asset` inputs, `rationale`, `notes`). Any
drift adds a warning. While a year is `PREPARING` or `AMENDING`, `basis` is
`LIVE` and `drift` compares the live figures with the latest filing, if any,
so an amendment shows what it changes. The report for a filed year is the
latest filing too, with the drift warning on top.

Filing records that you lodged the return elsewhere:

1. `POST /api/tax/years/:taxYear/filings { filedOn, reference?, note? }`
   (`file_tax_year`). It is refused (`409`, `details.positions`) while
   positions are `TO_REVIEW`, unless `allowUnreviewed: true`. It stores an
   immutable jsonb snapshot of every position and total, and the year becomes
   `FILED`. Each snapshot position carries a `detail`: its rationale and
   notes, the linked source transactions as they stood (account, date,
   amount, description, Up status), the labelled evidence URLs, and for asset
   positions the asset inputs (cost, dates, method, effective life or rate,
   ownership, disposal) and the schedule row's opening/closing values and
   days held. So a filing stays complete after evidence is removed, a link is
   undone, a transaction is deleted or an asset is edited.
2. A filed year is read-only. Creating, editing, moving or deleting its items,
   their links and evidence, and its asset-year records answers `409`. An
   asset that appears in a filed snapshot can't be deleted: record its
   disposal instead.
3. Assets, linked transactions and asset evidence stay editable, because
   they span years or live outside the tax ledger. The filed year keeps
   answering with its snapshot and reports the difference as `drift` (above).
   In an asset's schedule, the row for a filed year shows `filed.deduction`
   from the snapshot next to the recomputed figure, and sets `driftFromFiled`
   when they differ. History is never rewritten.
4. `POST /api/tax/years/:taxYear/amendment { reason }` (`reopen_tax_year`)
   moves the year to `AMENDING`. Filing again stores version 2 (`AMENDMENT`,
   with the reason). Earlier versions are kept unchanged:
   `GET /api/tax/years/:taxYear/filings/:version` (`get_tax_filing`).

Every write in a year first locks that year's `tax_returns` row (created on
first use). So filing and edits in the same year are serialized, and a filing
can't miss a concurrent edit.

## Example journey (MCP)

Tax operations are actions inside `tax_items`, `tax_assets`, or `tax_years`.
Each call wraps the action and its arguments in `request`. References to
individual operation names elsewhere in this guide refer to these actions.

> "Add this conference purchase to next year's tax return, planning to claim
> 100 % because it relates to my current work."

```jsonc
// tax_items
{ "request": { "action": "create_tax_item", "description": "AI Engineering Conference ticket", "date": "2026-09-10", "amount": "899",
  "category": "self-education", "claimPercent": "100",
  "rationale": "Relates directly to my current work as an AI engineer" } }
// → { "id": "…", "taxYear": "2026-27", "proposedAmount": "899.00", "status": "TO_REVIEW",
//     "gaps": ["needs-review", "no-evidence", "no-transaction"] }

// Later: the payment cleared. search_transactions { "text": "conference" } finds it.
// tax_items { "request": { "action": "link_tax_transaction", "itemId": "…", "upTransactionId": "…" } }
// tax_items { "request": { "action": "update_tax_item", "itemId": "…", "claimPercent": "50" } } → proposedAmount "449.50"
// tax_items { "request": { "action": "add_tax_evidence", "itemId": "…", "label": "Receipt", "url": "https://…", "kind": "RECEIPT" } }
```

> "Register my DGX Spark."

```jsonc
// tax_assets
{ "request": { "action": "register_tax_asset", "name": "NVIDIA DGX Spark", "cost": "6249", "acquiredOn": "2025-11-03", "firstUsedOn": "2025-11-10",
  "method": "DIMINISHING_VALUE", "effectiveLifeYears": "4", "defaultUsePercent": "80",
  "ownership": "Owned by me; used for consulting and research at home",
  "links": [{ "transactionId": "…" }] } }
// schedule.rows[0]: 2025-26, 233/365 days, decline 1994.54, deduction 1595.63 (80 %)

// tax_assets { "request": { "action": "set_tax_asset_year", "assetId": "…", "taxYear": "2026-27", "usePercent": "60" } }
// → 2026-27: opening 4254.46, decline 2127.23, deduction 1276.34
```

> "Show me my 2025-26 claims." `tax_years { "request": { "action": "get_tax_year_summary", "taxYear": "2025-26" } }`.
> Then review, record what you claimed, and `file_tax_year` once lodged.

The same journey runs end to end in `src/tax.e2e.spec.ts`.

## REST

| Method | Path | Notes |
|---|---|---|
| GET | `/api/tax/categories` | Suggested category slugs |
| GET, POST | `/api/tax/items` | List (`?taxYear=&kind=&category=&status=&source=linked\|unlinked&evidence=present\|missing&q=`), create |
| GET, PATCH, DELETE | `/api/tax/items/:itemId` | `PATCH` with `null` clears `date`, `amount`, `rationale`, `notes`, `claimedAmount` |
| POST | `/api/tax/links` | `{ itemId \| assetId, transactionId \| upTransactionId, note?, allowShared? }` |
| DELETE | `/api/tax/links/:linkId` | |
| POST | `/api/tax/evidence` | `{ itemId \| assetId, label, url, kind? }` |
| DELETE | `/api/tax/evidence/:evidenceId` | |
| GET, POST | `/api/tax/assets` | Register with optional `links` and `evidence` |
| GET, PATCH, DELETE | `/api/tax/assets/:assetId` | `GET ?throughYear=` |
| GET | `/api/tax/assets/:assetId/schedule` | `?throughYear=` |
| PUT | `/api/tax/assets/:assetId/years/:taxYear` | `{ usePercent?, status?, claimedAmount?, balancingClaimedAmount?, note? }` (`null` clears) |
| GET | `/api/tax/years` | |
| GET, PATCH | `/api/tax/years/:taxYear` | `PATCH { notes }` |
| GET | `/api/tax/years/:taxYear/report` | `?version=` |
| POST | `/api/tax/years/:taxYear/filings` | `{ filedOn, reference?, note?, allowUnreviewed? }` |
| GET | `/api/tax/years/:taxYear/filings/:version` | |
| POST | `/api/tax/years/:taxYear/amendment` | `{ reason }` |

## Limitations and follow-ups

- Australia only (`jurisdiction` is stored as `AU` so another one can be added
  later). No investment CGT, lot matching or dividend tax automation: those
  belong to a later phase.
- Year summaries are computed on read (and a filed year's drift is
  recomputed on every read).
- Amounts in another currency are kept as entered and flagged. Converting them
  to AUD is up to you.
