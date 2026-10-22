import { dateRange } from '../market-prices/market-calendar';
import { requestProgress, selectDueDates, type DueDatesInput, type ExistingDay } from './due-dates';
import { historyFloor } from './valuation-job.service';

const OLD = new Date('2026-01-01T00:00:00Z');
const RECENT = new Date('2026-01-20T00:00:00Z');
const day = (status: ExistingDay['status'] = 'COMPLETE', computedAt = RECENT, priceProvider = 'yahoo'): ExistingDay => ({ status, priceProvider, computedAt });
const filled = (from: string, to: string, value: ExistingDay = day()) => new Map(dateRange(from, to).map((d) => [d, value]));

const input = (overrides: Partial<DueDatesInput>): DueDatesInput => ({
  floor: '2025-01-01',
  settled: '2025-01-31',
  existing: new Map(),
  priceProvider: 'yahoo',
  requests: [],
  recheckFrom: '2025-01-24',
  partialRetryBefore: new Date('2026-01-10T00:00:00Z'),
  maxDays: 1000,
  ...overrides,
});

describe('historyFloor', () => {
  it('starts at the first purchase however long ago, unless a cap is configured', () => {
    expect(historyFloor('2019-04-02', '2026-01-15', null)).toBe('2019-04-02');
    expect(historyFloor('2019-04-02', '2026-01-15', 366)).toBe('2025-01-14');
    expect(historyFloor('2025-06-01', '2026-01-15', 366)).toBe('2025-06-01');
  });
});

describe('selectDueDates', () => {
  it('backfills a gap newest first, in batches, returned oldest first', () => {
    // Materialised from the 21st; the 1st–20th are missing
    const existing = filled('2025-01-21', '2025-01-31');
    const first = selectDueDates(input({ existing, maxDays: 8 }));
    expect(first).toEqual({ due: dateRange('2025-01-13', '2025-01-20'), remaining: 12 });
    // Next run: the batch is stored, the next older batch is due
    const after = new Map([...existing, ...filled('2025-01-13', '2025-01-20')]);
    expect(selectDueDates(input({ existing: after, maxDays: 8 }))).toEqual({ due: dateRange('2025-01-05', '2025-01-12'), remaining: 4 });
  });

  it('puts regular work ahead of older history: the newest missing date comes first', () => {
    // Yesterday is missing too (a new day settled) while the backfill is half way
    const existing = filled('2025-01-21', '2025-01-30');
    expect(selectDueDates(input({ existing, maxDays: 3 })).due).toEqual(['2025-01-19', '2025-01-20', '2025-01-31']);
  });

  it('re-does PARTIAL days in the recheck window, other providers\' days and requested dates', () => {
    const existing = filled('2025-01-01', '2025-01-31');
    existing.set('2025-01-25', day('PARTIAL'));
    existing.set('2025-01-10', day('COMPLETE', RECENT, 'mock'));
    const due = selectDueDates(input({ existing, requests: [{ fromDate: '2025-01-29', recomputedFrom: null }] })).due;
    expect(due).toEqual(['2025-01-10', '2025-01-25', '2025-01-29', '2025-01-30', '2025-01-31']);
  });

  it('skips dates a request has already re-valued (its checkpoint)', () => {
    const existing = filled('2025-01-01', '2025-01-31');
    const due = selectDueDates(input({ existing, requests: [{ fromDate: '2025-01-03', recomputedFrom: '2025-01-06' }] })).due;
    expect(due).toEqual(['2025-01-03', '2025-01-04', '2025-01-05']);
  });

  it('re-tries old PARTIAL days only after a while, and after everything else', () => {
    const existing = filled('2025-01-01', '2025-01-31');
    existing.set('2025-01-02', day('PARTIAL', OLD));
    existing.set('2025-01-03', day('PARTIAL', RECENT));
    existing.delete('2025-01-15');
    expect(selectDueDates(input({ existing })).due).toEqual(['2025-01-02', '2025-01-15']);
    expect(selectDueDates(input({ existing, maxDays: 1 }))).toEqual({ due: ['2025-01-15'], remaining: 1 });
  });

  it('has nothing to do before the first date settles', () => {
    expect(selectDueDates(input({ floor: '2025-02-01' }))).toEqual({ due: [], remaining: 0 });
  });
});

describe('requestProgress', () => {
  const request = { fromDate: '2025-01-05', recomputedFrom: null };

  it('is done once every covered date was re-valued', () => {
    expect(requestProgress(request, '2025-01-01', '2025-01-10', new Set(dateRange('2025-01-05', '2025-01-10')))).toEqual({ done: true });
  });

  it('checkpoints just above the newest date still left', () => {
    expect(requestProgress(request, '2025-01-01', '2025-01-10', new Set(dateRange('2025-01-08', '2025-01-10')))).toEqual({ done: false, recomputedFrom: '2025-01-08' });
    // Resuming from a checkpoint: only the dates below it count
    const resumed = { fromDate: '2025-01-05', recomputedFrom: '2025-01-08' };
    expect(requestProgress(resumed, '2025-01-01', '2025-01-10', new Set(['2025-01-06', '2025-01-07']))).toEqual({ done: false, recomputedFrom: '2025-01-06' });
    expect(requestProgress(resumed, '2025-01-01', '2025-01-10', new Set(['2025-01-05', '2025-01-06', '2025-01-07']))).toEqual({ done: true });
  });

  it('ignores dates before the history starts', () => {
    expect(requestProgress({ fromDate: '2024-01-01', recomputedFrom: null }, '2025-01-09', '2025-01-10', new Set(['2025-01-09', '2025-01-10']))).toEqual({ done: true });
  });
});
