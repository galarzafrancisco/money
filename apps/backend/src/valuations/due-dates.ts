import { addDays, dateRange } from '../market-prices/market-calendar';

export type ExistingDay = { status: 'COMPLETE' | 'PARTIAL'; priceProvider: string; computedAt: Date };

/**
 * A recompute request as the job sees it. recomputedFrom is its checkpoint:
 * dates from it onwards were already re-valued for this request (null: none
 * yet). Renewing the request (a newer backdated change) resets it.
 */
export type RequestCheckpoint = { fromDate: string; recomputedFrom: string | null };

export type DueDatesInput = {
  /** The first date the history has to cover (the first purchase, or the configured cap) */
  floor: string;
  /** The latest settled valuation date */
  settled: string;
  existing: ReadonlyMap<string, ExistingDay>;
  priceProvider: string;
  requests: readonly RequestCheckpoint[];
  /** PARTIAL days on or after this date are re-tried on every run */
  recheckFrom: string;
  /** Older PARTIAL days are re-tried once their snapshot was computed before this instant */
  partialRetryBefore: Date;
  maxDays: number;
};

export type DueDates = {
  /** The dates to compute in this run, oldest first */
  due: string[];
  /** Due dates left for a later run */
  remaining: number;
};

/** The request still needs this date re-valued */
export function requestCovers(request: RequestCheckpoint, date: string): boolean {
  return request.fromDate <= date && (request.recomputedFrom === null || date < request.recomputedFrom);
}

/**
 * Picks the dates one run should (re)compute, in priority order, at most
 * maxDays of them:
 *
 * 1. regular work: dates with no snapshot, snapshots priced by another
 *    provider, PARTIAL days in the recheck window, and dates a recompute
 *    request still covers;
 * 2. older PARTIAL days not re-tried for a while (provider outages, late data).
 *
 * Within each tier the newest dates come first, so recent history is filled
 * before older history, which then grows backwards run by run.
 */
export function selectDueDates(input: DueDatesInput): DueDates {
  if (input.floor > input.settled) return { due: [], remaining: 0 };
  const regular: string[] = [];
  const retries: string[] = [];
  for (const date of dateRange(input.floor, input.settled).reverse()) {
    const day = input.existing.get(date);
    if (
      !day ||
      day.priceProvider !== input.priceProvider ||
      (day.status === 'PARTIAL' && date >= input.recheckFrom) ||
      input.requests.some((r) => requestCovers(r, date))
    ) {
      regular.push(date);
    } else if (day.status === 'PARTIAL' && day.computedAt.getTime() < input.partialRetryBefore.getTime()) {
      retries.push(date);
    }
  }
  const all = [...regular, ...retries];
  const due = all.slice(0, input.maxDays).sort();
  return { due, remaining: all.length - due.length };
}

/**
 * Where a request stands once `computed` (this run's dates) are re-valued:
 * `done` when nothing it covers in [floor, settled] is left, otherwise the new
 * checkpoint (every covered date from it onwards is now re-valued).
 */
export function requestProgress(
  request: RequestCheckpoint,
  floor: string,
  settled: string,
  computed: ReadonlySet<string>,
): { done: true } | { done: false; recomputedFrom: string } {
  let latestLeft: string | null = null;
  const start = request.fromDate > floor ? request.fromDate : floor;
  for (const date of start <= settled ? dateRange(start, settled) : []) {
    if (requestCovers(request, date) && !computed.has(date)) latestLeft = date;
  }
  return latestLeft === null ? { done: true } : { done: false, recomputedFrom: addDays(latestLeft, 1) };
}
