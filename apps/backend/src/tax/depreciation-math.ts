import { dec, MoneyDecimal, ZERO } from '../common/decimal';
import { daysBetweenInclusive, taxYearLabel, taxYearOf, taxYearPeriod } from './financial-year';

/**
 * Decline-in-value estimates for a depreciating asset, by Australian
 * financial year. Pure and deterministic: the same inputs always give the
 * same schedule. Every rate, effective life and method is the user's own
 * input; nothing here decides eligibility or looks up an ATO determination.
 * See apps/backend/docs/tax.md.
 */

export const DEPRECIATION_METHODS = ['PRIME_COST', 'DIMINISHING_VALUE', 'IMMEDIATE'] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

/**
 * Identifies the calculation rules a schedule was produced with. Bump it when
 * the formulas change, so filed snapshots record which rules they used.
 */
export const DEPRECIATION_RULES_VERSION = 'au-decline-in-value/2026.1';

/** Safety bound on schedule length */
export const MAX_SCHEDULE_YEARS = 100;

export type DepreciationInput = {
  cost: string;
  /** First used or installed ready for use (YYYY-MM-DD). Null: not used yet, so no decline yet. */
  startDate: string | null;
  method: DepreciationMethod;
  /** Years, as a decimal string. Needed unless ratePercent is given or the method is IMMEDIATE. */
  effectiveLifeYears: string | null;
  /** Overrides the rate derived from effective life (per cent per full year) */
  ratePercent: string | null;
  /** Work/business use per cent for years without their own figure */
  defaultUsePercent: string;
  /** Use per cent per financial year (start year → per cent) */
  usePercentByYear?: ReadonlyMap<number, string>;
  disposedOn: string | null;
  /** Termination value on disposal (sale proceeds, insurance payout…). Null counts as 0. */
  disposalProceeds: string | null;
};

export type BalancingAdjustment = {
  terminationValue: string;
  adjustableValue: string;
  /** terminationValue − adjustableValue: positive is an estimated assessable amount, negative an estimated deduction */
  amount: string;
  /** amount × use per cent */
  taxableAmount: string;
};

export type ScheduleRow = {
  taxYear: string;
  startYear: number;
  periodStart: string;
  periodEnd: string;
  daysHeld: number;
  daysInYear: number;
  openingValue: string;
  /** The full decline in value for the year, before use apportionment */
  decline: string;
  closingValue: string;
  usePercent: string;
  usePercentSource: 'year' | 'default';
  /** decline × use per cent: the proposed deduction estimate */
  deduction: string;
  /** decline − deduction: the private (non-claimable) portion */
  privatePortion: string;
  balancingAdjustment: BalancingAdjustment | null;
  /** How the figure was worked out, in words */
  workings: string;
};

export type ScheduleEnd = 'WRITTEN_OFF' | 'DISPOSED' | 'HORIZON' | 'NOT_STARTED';

export type DepreciationSchedule = {
  rulesVersion: string;
  method: DepreciationMethod;
  /** Per cent per full year actually used; null for IMMEDIATE */
  ratePercent: string | null;
  rateSource: 'override' | 'effective-life' | 'immediate';
  firstYear: string | null;
  rows: ScheduleRow[];
  endReason: ScheduleEnd;
  totals: { decline: string; deduction: string; privatePortion: string };
};

const HUNDRED = new MoneyDecimal(100);
const cents = (value: MoneyDecimal) => value.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP);
const money = (value: MoneyDecimal) => cents(value).toFixed(2);
const plain = (value: MoneyDecimal) => {
  const text = value.toDecimalPlaces(6, MoneyDecimal.ROUND_HALF_UP).toFixed();
  return text === '-0' ? '0' : text;
};

/** The yearly rate in per cent: the override, else 100/life (prime cost) or 200/life (diminishing value) */
export function rateFor(input: Pick<DepreciationInput, 'method' | 'effectiveLifeYears' | 'ratePercent'>): { rate: MoneyDecimal | null; source: DepreciationSchedule['rateSource'] } {
  if (input.method === 'IMMEDIATE') return { rate: null, source: 'immediate' };
  if (input.ratePercent !== null) return { rate: dec(input.ratePercent), source: 'override' };
  if (input.effectiveLifeYears === null) throw new Error('effectiveLifeYears or ratePercent is required');
  const life = dec(input.effectiveLifeYears);
  return { rate: (input.method === 'PRIME_COST' ? HUNDRED : HUNDRED.times(2)).div(life), source: 'effective-life' };
}

/** A sensible default horizon: the year a prime-cost write-off would finish, given the rate */
export function defaultHorizon(input: DepreciationInput, currentYear: number): number {
  if (!input.startDate) return currentYear;
  const first = taxYearOf(input.startDate);
  if (input.method === 'IMMEDIATE') return Math.max(first, currentYear);
  const { rate } = rateFor(input);
  const years = rate && rate.gt(0) ? Math.ceil(HUNDRED.div(rate).toNumber()) : 1;
  return Math.min(first + MAX_SCHEDULE_YEARS - 1, Math.max(currentYear, first + years));
}

/**
 * The schedule from the first year of use until the asset is written off,
 * disposed of, or `throughYear` (a financial-year start year) is reached.
 */
export function depreciationSchedule(input: DepreciationInput, throughYear: number): DepreciationSchedule {
  const { rate, source } = rateFor(input);
  const empty = (endReason: ScheduleEnd): DepreciationSchedule => ({
    rulesVersion: DEPRECIATION_RULES_VERSION,
    method: input.method,
    ratePercent: rate ? plain(rate) : null,
    rateSource: source,
    firstYear: input.startDate ? taxYearLabel(taxYearOf(input.startDate)) : null,
    rows: [],
    endReason,
    totals: { decline: '0.00', deduction: '0.00', privatePortion: '0.00' },
  });
  if (!input.startDate) return empty('NOT_STARTED');

  const cost = dec(input.cost);
  const first = taxYearOf(input.startDate);
  const disposalYear = input.disposedOn ? taxYearOf(input.disposedOn) : null;
  const last = Math.min(throughYear, disposalYear ?? Number.MAX_SAFE_INTEGER, first + MAX_SCHEDULE_YEARS - 1);
  const rows: ScheduleRow[] = [];
  let opening = cost;
  let endReason: ScheduleEnd = 'HORIZON';

  for (let year = first; year <= last; year++) {
    const period = taxYearPeriod(year);
    const from = year === first ? input.startDate : period.start;
    const disposedHere = disposalYear === year;
    const to = disposedHere ? (input.disposedOn as string) : period.end;
    const daysHeld = daysBetweenInclusive(from, to);
    const fraction = dec(daysHeld).div(period.days);

    let raw: MoneyDecimal;
    let workings: string;
    if (input.method === 'IMMEDIATE') {
      raw = year === first ? opening : ZERO;
      workings = year === first ? `Immediate deduction of the full cost ${money(cost)} in the first year of use (your assertion; eligibility is not checked).` : 'Already written off.';
    } else if (input.method === 'PRIME_COST') {
      raw = cost.times(rate as MoneyDecimal).div(HUNDRED).times(fraction);
      workings = `Prime cost: cost ${money(cost)} × ${plain(rate as MoneyDecimal)}% × ${daysHeld}/${period.days} days`;
    } else {
      raw = opening.times(rate as MoneyDecimal).div(HUNDRED).times(fraction);
      workings = `Diminishing value: opening value ${money(opening)} × ${plain(rate as MoneyDecimal)}% × ${daysHeld}/${period.days} days`;
    }
    let decline = MoneyDecimal.min(cents(raw), opening);
    if (decline.lt(0)) decline = ZERO;
    if (input.method !== 'IMMEDIATE' && cents(raw).gt(opening)) workings += `, capped at the remaining value ${money(opening)}`;
    if (input.method !== 'IMMEDIATE') workings += ` = ${money(decline)}`;

    const yearUse = input.usePercentByYear?.get(year);
    const usePercent = dec(yearUse ?? input.defaultUsePercent);
    const deduction = cents(decline.times(usePercent).div(HUNDRED));
    const closingBeforeDisposal = opening.minus(decline);
    workings += `; deduction at ${plain(usePercent)}% work use = ${money(deduction)}.`;

    let balancing: BalancingAdjustment | null = null;
    let closing = closingBeforeDisposal;
    if (disposedHere) {
      const termination = dec(input.disposalProceeds ?? '0');
      const amount = termination.minus(closingBeforeDisposal);
      balancing = {
        terminationValue: money(termination),
        adjustableValue: money(closingBeforeDisposal),
        amount: money(amount),
        taxableAmount: money(amount.times(usePercent).div(HUNDRED)),
      };
      workings += ` Disposed of on ${input.disposedOn}: termination value ${money(termination)} − adjustable value ${money(closingBeforeDisposal)} = balancing adjustment ${money(amount)} (estimate).`;
      closing = ZERO;
    }

    rows.push({
      taxYear: period.taxYear,
      startYear: year,
      periodStart: from,
      periodEnd: to,
      daysHeld,
      daysInYear: period.days,
      openingValue: money(opening),
      decline: money(decline),
      closingValue: money(closing),
      usePercent: plain(usePercent),
      usePercentSource: yearUse === undefined ? 'default' : 'year',
      deduction: money(deduction),
      privatePortion: money(decline.minus(deduction)),
      balancingAdjustment: balancing,
      workings,
    });
    opening = closing;
    if (disposedHere) {
      endReason = 'DISPOSED';
      break;
    }
    if (closing.lte(0)) {
      endReason = 'WRITTEN_OFF';
      break;
    }
  }

  const sum = (key: 'decline' | 'deduction' | 'privatePortion') => money(rows.reduce((total, r) => total.plus(r[key]), ZERO));
  return { ...empty(endReason), rows, totals: { decline: sum('decline'), deduction: sum('deduction'), privatePortion: sum('privatePortion') } };
}
