import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { addDays, dateRange, daysBetween, isWeekend } from '../market-prices/market-calendar';
import { MARKET_PRICE_PROVIDER, type DailyCloseSeries, type MarketPriceProvider } from '../market-prices/market-price.port';
import { PriceStoreRepository, type StoredSeriesMeta } from '../market-prices/price-store.repository';
import type { SeriesResult } from './valuation-math';
import { ValuationsRepository } from './valuations.repository';

/**
 * A day this long ago without a close is taken as a day without a session
 * once the provider has been asked about it. More recent missing days are
 * asked about again, as a late close may still arrive.
 */
const FINAL_AFTER_DAYS = 7;

type Gap = { from: string; to: string; lower: boolean };

/**
 * Daily closes, store first. For each symbol the store knows a contiguous
 * covered range of trading dates (market_price_series). A lookup reads the
 * store and asks the provider only for the dates outside that range, in as
 * few requests as possible (one per gap, split at MARKET_PRICE_MAX_FETCH_DAYS),
 * stores what comes back and answers from the store. Finalised closes are
 * immutable unless explicitly refreshed (refresh()); a refresh that finds a
 * different close re-values every user's affected snapshots.
 *
 * When the provider fails, whatever is stored is used and the result says
 * so (`warning`); with nothing stored the symbol gets an error, and its
 * holdings are MISSING for the affected dates, to be re-tried. Prices are
 * never made up and cost base is never used in their place.
 */
@Injectable()
export class PriceHistoryService {
  private readonly logger = new Logger('PriceHistory');
  /** One fetch at a time per series in this process, so concurrent callers share one request */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(MARKET_PRICE_PROVIDER) private readonly provider: MarketPriceProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly store: PriceStoreRepository,
    private readonly valuations: ValuationsRepository,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  async getSeries(symbols: readonly string[], range: { from: string; to: string }, now: Date): Promise<Map<string, SeriesResult>> {
    const results = new Map<string, SeriesResult>();
    // The provider wrapper limits concurrency globally; this only bounds the queue
    const queue = [...new Set(symbols)];
    const worker = async () => {
      for (let symbol = queue.shift(); symbol !== undefined; symbol = queue.shift()) {
        results.set(symbol, await this.withLock(symbol, () => this.getOne(symbol, range, now)));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return results;
  }

  /**
   * Makes the next lookup of `symbol` fetch every close from `fromDate` again.
   * Any close that comes back different replaces the stored one and
   * re-values the affected dates of every user holding the symbol.
   */
  async refresh(symbol: string, fromDate: string): Promise<void> {
    await this.withLock(symbol, () => this.store.forgetCoverageFrom(symbol, this.provider.name, fromDate));
  }

  private async getOne(symbol: string, range: { from: string; to: string }, now: Date): Promise<SeriesResult> {
    const source = this.provider.name;
    const today = now.toISOString().slice(0, 10);
    // Exchanges east of UTC are at most a day ahead
    const to = range.to < addDays(today, 1) ? range.to : addDays(today, 1);
    if (range.from > to) return { error: `No history can exist after ${to}` };

    let meta = await this.store.meta(symbol, source);
    const failures: string[] = [];
    let unknown = false;
    let fetched: DailyCloseSeries | null = null;
    for (const gap of this.gaps(meta, range.from, to)) {
      try {
        const series = await this.provider.getDailyCloses(symbol, { from: gap.from, to: gap.to }, now);
        if (!series) {
          unknown = true;
          break;
        }
        fetched = series;
        const problem = validate(series, symbol, gap);
        if (problem) throw new Error(`${source} returned unusable history for ${symbol}: ${problem}`);
        const last = series.closes[series.closes.length - 1]?.tradingDate ?? null;
        const settled = addDays(today, -FINAL_AFTER_DAYS);
        // Below the stored range every day has a later session; above it, only up to the last close or long-past days are final
        const coveredTo = gap.lower ? gap.to : [last ?? '', gap.to < settled ? gap.to : settled].sort()[1];
        const changed = await this.store.saveFetch(series, coveredTo >= gap.from ? { from: gap.from, to: coveredTo } : null);
        if (changed.length > 0) {
          this.logger.warn(`${changed.length} stored close(s) of ${symbol} changed (first ${changed[0]}); re-valuing holders`);
          await this.valuations.requestRecomputeForSymbol(symbol, changed[0]);
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        break;
      }
    }
    if (failures.length > 0 || unknown) meta = await this.store.meta(symbol, source);
    else meta ??= await this.store.meta(symbol, source);

    const stored = await this.stored(symbol, source, meta, range.from, to);
    if (failures.length > 0) {
      if (!stored) {
        this.logger.warn(failures[0]);
        return { error: failures[0] };
      }
      const warning = `${failures[0]}; using stored closes${meta ? ` (complete through ${meta.coveredTo}, fetched ${meta.fetchedAt})` : ''}`;
      this.logger.warn(warning);
      return { series: stored, warning };
    }
    if (unknown && !stored) return { series: null };
    // No session stored yet (e.g. a weekend right after listing): an empty series still says the symbol is known
    return { series: stored ?? (fetched ? { ...fetched, splits: [], closes: [] } : null) };
  }

  /** The date ranges outside the stored range, extended so the stored range stays contiguous */
  private gaps(meta: StoredSeriesMeta | null, from: string, to: string): Gap[] {
    const raw: Gap[] = [];
    if (!meta) raw.push({ from, to, lower: false });
    else {
      if (from < meta.coveredFrom) raw.push({ from, to: addDays(meta.coveredFrom, -1), lower: true });
      if (to > meta.coveredTo) raw.push({ from: addDays(meta.coveredTo, 1), to, lower: false });
    }
    const max = this.config.marketPrices.maxFetchDays;
    const gaps: Gap[] = [];
    // A weekend after the stored range has no session anywhere Money looks: nothing to ask for yet
    for (const gap of raw.filter((g) => g.lower || dateRange(g.from, g.to).some((d) => !isWeekend(d)))) {
      // Lower gaps are fetched newest first so each part stays adjacent to the stored range
      const parts: Gap[] = [];
      for (let start = gap.from; start <= gap.to; start = addDays(start, max)) {
        const end = addDays(start, max - 1);
        parts.push({ from: start, to: end < gap.to ? end : gap.to, lower: gap.lower });
      }
      gaps.push(...(gap.lower ? parts.reverse() : parts));
    }
    return gaps;
  }

  private async stored(symbol: string, source: string, meta: StoredSeriesMeta | null, from: string, to: string): Promise<DailyCloseSeries | null> {
    if (!meta) return null;
    const [closes, splits] = await Promise.all([this.store.closes(symbol, source, from, to), this.store.splits(symbol, source, from)]);
    return {
      ...emptySeries(meta),
      splits,
      closes: closes.map(({ tradingDate, close, closeTime }) => ({ tradingDate, close, closeTime })),
    };
  }

  private async withLock<T>(symbol: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(symbol) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.locks.set(symbol, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(symbol) === next) this.locks.delete(symbol);
    }
  }
}

function emptySeries(meta: StoredSeriesMeta): DailyCloseSeries {
  return {
    symbol: meta.symbol,
    currency: meta.currency,
    exchangeTimezone: meta.exchangeTimezone,
    source: meta.source,
    isMock: meta.isMock,
    adjustment: 'AS_TRADED',
    splits: [],
    closes: [],
  };
}

/** What the provider returned must fit what was asked for before it is stored */
function validate(series: DailyCloseSeries, symbol: string, gap: Gap): string | null {
  if (series.symbol !== symbol.toUpperCase() && series.symbol !== symbol) return `symbol ${series.symbol}`;
  if (!/^[A-Z]{3}$/.test(series.currency)) return `currency ${series.currency}`;
  if (series.adjustment !== 'AS_TRADED') return `closes are ${series.adjustment}, not as traded`;
  let previous = '';
  for (const close of series.closes) {
    if (close.tradingDate < gap.from || close.tradingDate > gap.to) return `close dated ${close.tradingDate} outside ${gap.from}..${gap.to}`;
    if (close.tradingDate <= previous) return 'closes out of order or duplicated';
    if (!/^\d+(\.\d+)?$/.test(close.close) || Number(close.close) <= 0) return `close ${close.close} on ${close.tradingDate}`;
    previous = close.tradingDate;
  }
  for (const split of series.splits) if (!(Number(split.numerator) > 0 && Number(split.denominator) > 0)) return `split on ${split.date}`;
  return daysBetween(gap.from, gap.to) < 0 ? 'empty range' : null;
}
