# Accounting assumptions (Australia)

> **Not tax advice.** Money is a personal tracker. These defaults were chosen to
> be explicit and easy to change, not as a ruling on anyone's tax position.
> Check figures with the ATO or a registered tax agent before using them in a
> return. API and MCP responses carry the same caveat in `notes`.

## What Money does today

| Topic | Behaviour | Basis / remark |
|---|---|---|
| **Cost base** | Price × quantity **plus brokerage**, per parcel. | The ATO counts incidental costs of acquisition, such as brokerage, in the cost base. Other cost-base elements (e.g. capital costs, non-deductible holding costs) are not modelled. |
| **Proceeds** | Sale price × quantity **minus brokerage**. | Incidental costs of disposal reduce the capital gain. |
| **Parcel matching** | **Specific identification** when a sale gives `allocations` (which purchases, how many from each, possibly part of several). Otherwise **FIFO**: the oldest open parcels first. | The ATO lets you identify the parcels you sold when you can tell them apart, and accepts FIFO when you can't. Money records your choice; it doesn't pick one for you. Explicit picks are never re-matched; FIFO matches follow the history. See [lot-selection.md](lot-selection.md). |
| **Partial parcels** | Cost base is split in proportion to the quantity taken from the parcel. Sale fees and net proceeds are split across parcels in proportion to quantity, rounded to 10 dp. | The last slice takes the remainder, and a slice that empties a parcel takes all of its remaining cost base, so the parts add up exactly. |
| **Holding period** | Per parcel taken: `daysHeld` and `heldOverTwelveMonths`. | Supports tax analysis; it is not a complete CGT calculation. |
| **Realized gain / loss** | Net proceeds − cost base of the parcels sold, per sale and per parcel. | A **capital gain or loss before** discounts, carried-forward losses or any other CGT step. |
| **Unrealized gain / loss** | Market value (current quote × quantity) − remaining cost base. | Only when the quote's currency matches the trade currency. Mock prices are labelled. |
| **12-month test** | `heldOverTwelveMonths` is true when the disposal date is after the 12-month anniversary of the acquisition date. The days of acquisition and disposal are excluded, as the ATO counts them. | **No 50% discount is applied.** Eligibility also depends on residency and entity type. |
| **Currencies** | Cost base, proceeds and gains stay **in the currency of the trade**. Cash is tracked per currency. Nothing is converted to AUD. | See "Open questions". |
| **FX conversions** | Recorded as a cash movement between currencies, with the rate given or calculated and an optional fee in the currency sold. | **No foreign-currency gain or loss** is computed on the cash (Division 775 forex realisation events are not modelled). |
| **Dividends** | Gross, tax withheld at source and net received. Net is credited as cash. Optional **franking credits** are recorded (not cash). | Withholding is recorded for reporting; foreign-income-tax-offset limits are not calculated. Franking credits are totals for reporting only; no gross-up or offset calculation. |
| **Dates** | Calendar date of the trade as recorded (`date`), not the settlement date. | CGT event timing is generally the contract (trade) date. |
| **Rounding** | Calculated money amounts are rounded to the currency's minor unit (e.g. cents), half up. Calculated quantities and prices keep 10 decimal places. Supplied values are kept as given. | Four supplied trade values must agree within 0.01. |

## Open questions

These need Francisco's decision before Money can report AUD tax figures:

1. **AUD conversion for CGT on US shares.** The ATO generally converts the cost
   base at the exchange rate on the acquisition date, and the proceeds at the
   rate on the disposal date. Should Money record an AUD rate on each foreign
   trade (entered, or taken from the account's FX conversions), or fetch
   historical RBA rates?
2. **Parcel selection.** Resolved: FIFO stays the default and specific
   identification is available per sale ([lot-selection.md](lot-selection.md)).
   There is no automatic "minimise gain" selection.
3. **Forex gains on foreign cash.** USD cash held and later converted can give
   a forex gain or loss (Division 775, with the $250k balance election). Model
   it, or leave it out of scope?
4. **CGT discount.** Should Money show a "discounted gain" figure, given
   residency, or only the eligibility flag?
5. **Dividend reinvestment plans (DRP), corporate actions** (splits, mergers,
   return of capital, AMIT cost-base adjustments for ETFs such as VAS). None are
   modelled yet. AMIT adjustments in particular change the cost base of
   Australian ETFs every year.
6. **Same-day ordering.** Transactions on the same date replay in the order
   they were recorded. Is that enough, or do intraday trades need a time?
7. **Reporting.** No financial-year (1 July to 30 June) summaries yet. Is that
   the next step for tax time?
8. **Taico token details.** The expected `iss` and audience for Taico-minted
   tokens are configurable (`TAICO_ISSUER`, `PUBLIC_BASE_URL`). They still need
   checking against a live Taico MCP server registration for Money, including
   whether Taico's per-MCP-server issuer differs from its base issuer.
