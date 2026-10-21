/**
 * Calendar-date and time-zone helpers for daily closing prices. Dates are
 * ISO calendar dates (YYYY-MM-DD) with no time zone of their own: a trading
 * date is the date in the exchange's local time zone.
 *
 * There is no exchange holiday calendar here. Weekends are known to be
 * non-trading for every exchange Money supports (all trade Monday–Friday);
 * holidays are inferred from the provider's history (a later session exists
 * but none for that date). See docs/valuations.md.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from a to b (b − a) */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/** Every date from `from` to `to`, both included */
export function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  return dates;
}

export function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone */
export function zonedParts(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

/** The calendar date of an instant in a time zone */
export function dateInZone(instant: Date, timeZone: string): string {
  return zonedParts(instant, timeZone).date;
}

/**
 * The instant at which the wall clock in `timeZone` shows `date` `time`
 * (HH:MM or HH:MM:SS). Handles daylight saving by correcting for the zone's
 * offset at the guessed instant, twice.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [h, m, s] = time.split(':').map(Number);
  const [y, mo, d] = date.split('-').map(Number);
  const wanted = Date.UTC(y, mo - 1, d, h, m, s ?? 0);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const parts = zonedParts(new Date(guess), timeZone);
    const [py, pmo, pd] = parts.date.split('-').map(Number);
    const [ph, pm, ps] = parts.time.split(':').map(Number);
    const shown = Date.UTC(py, pmo - 1, pd, ph, pm, ps);
    guess += wanted - shown;
  }
  return new Date(guess);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}
