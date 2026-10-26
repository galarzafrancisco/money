/**
 * Australian financial years: 1 July to 30 June. A year is identified by the
 * calendar year it starts in (2026 = FY 2026-27, 1 Jul 2026 - 30 Jun 2027)
 * and written "2026-27" on the wire. Pure, no I/O.
 */

export const JURISDICTION = 'AU' as const;

/** Inclusive bounds of the years Money accepts */
export const MIN_TAX_YEAR = 1990;
export const MAX_TAX_YEAR = 2100;

const PATTERN = /^(?:FY\s*)?(\d{4})\s*[-–—/]\s*(\d{2}|\d{4})$/i;

/** "2026-27", "FY2026-27", "2026–27", "2026/2027" → 2026. Anything else → null. */
export function parseTaxYear(value: string): number | null {
  const match = PATTERN.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2].length === 2 ? Number(match[2]) : Number(match[2]) % 100;
  if (end !== (start + 1) % 100) return null;
  if (start < MIN_TAX_YEAR || start > MAX_TAX_YEAR) return null;
  return start;
}

/** 2026 → "2026-27" */
export function taxYearLabel(start: number): string {
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The financial year a calendar date (YYYY-MM-DD) falls in */
export function taxYearOf(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= 7 ? year : year - 1;
}

export type TaxYearPeriod = { taxYear: string; startYear: number; start: string; end: string; days: number };

export function taxYearPeriod(start: number): TaxYearPeriod {
  const from = `${start}-07-01`;
  const to = `${start + 1}-06-30`;
  return { taxYear: taxYearLabel(start), startYear: start, start: from, end: to, days: daysBetweenInclusive(from, to) };
}

const DAY_MS = 86_400_000;

function utc(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

/** Whole days from `from` to `to`, both counted. 0 when `to` is before `from`. */
export function daysBetweenInclusive(from: string, to: string): number {
  const days = Math.round((utc(to) - utc(from)) / DAY_MS) + 1;
  return Math.max(0, days);
}

/** Today's date in Australia/Sydney, YYYY-MM-DD (the "current" financial year is Australian) */
export function todayInAustralia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
