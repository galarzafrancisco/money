import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../database/unit-of-work';
import { MARKET_PRICE_PROVIDER, type DailyCloseSeries, type MarketPriceProvider } from '../market-prices/market-price.port';
import type { SeriesResult } from './valuation-math';

type StoredClose = {
  symbol: string;
  trading_date: string;
  close: string;
  currency: string;
  exchange_timezone: string;
  close_time: Date | null;
  is_mock: boolean;
};

/**
 * Daily closes through the configured provider. Every close fetched is kept
 * in market_price_closes (an audit trail of what valuations used). When the
 * provider fails, closes stored earlier for the same source are used instead,
 * if there are any; otherwise the symbol gets an error and its holdings are
 * MISSING for the affected dates, to be re-tried.
 */
@Injectable()
export class PriceHistoryService {
  private readonly logger = new Logger('PriceHistory');

  constructor(
    @Inject(MARKET_PRICE_PROVIDER) private readonly provider: MarketPriceProvider,
    private readonly uow: UnitOfWork,
  ) {}

  get providerName(): string {
    return this.provider.name;
  }

  async getSeries(symbols: readonly string[], range: { from: string; to: string }, now: Date): Promise<Map<string, SeriesResult>> {
    const results = new Map<string, SeriesResult>();
    // A few at a time, to be gentle with free providers
    const queue = [...new Set(symbols)];
    const worker = async () => {
      for (let symbol = queue.shift(); symbol !== undefined; symbol = queue.shift()) {
        results.set(symbol, await this.fetchOne(symbol, range, now));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return results;
  }

  private async fetchOne(symbol: string, range: { from: string; to: string }, now: Date): Promise<SeriesResult> {
    try {
      const series = await this.provider.getDailyCloses(symbol, range, now);
      if (series) await this.store(series);
      return { series };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stored = await this.loadStored(symbol, range);
      if (stored) {
        this.logger.warn(`${message}; using ${stored.closes.length} stored closes for ${symbol}`);
        return { series: stored };
      }
      this.logger.warn(message);
      return { error: message };
    }
  }

  private async store(series: DailyCloseSeries): Promise<void> {
    if (series.closes.length === 0) return;
    const values: unknown[] = [];
    const rows = series.closes.map((close, i) => {
      values.push(series.symbol, series.source, close.tradingDate, close.close, series.currency, series.exchangeTimezone, close.closeTime, series.isMock);
      const p = i * 8;
      return `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7}, $${p + 8})`;
    });
    await this.uow.manager.query(
      `INSERT INTO market_price_closes (symbol, source, trading_date, close, currency, exchange_timezone, close_time, is_mock)
       VALUES ${rows.join(', ')}
       ON CONFLICT (symbol, source, trading_date) DO UPDATE SET
         close = EXCLUDED.close, currency = EXCLUDED.currency, exchange_timezone = EXCLUDED.exchange_timezone,
         close_time = EXCLUDED.close_time, is_mock = EXCLUDED.is_mock, fetched_at = now()`,
      values,
    );
  }

  private async loadStored(symbol: string, range: { from: string; to: string }): Promise<DailyCloseSeries | null> {
    const rows: StoredClose[] = await this.uow.manager.query(
      `SELECT symbol, to_char(trading_date, 'YYYY-MM-DD') AS trading_date, close::text AS close, currency, exchange_timezone, close_time, is_mock
         FROM market_price_closes
        WHERE symbol = $1 AND source = $2 AND trading_date BETWEEN $3 AND $4
        ORDER BY trading_date`,
      [symbol, this.provider.name, range.from, range.to],
    );
    if (rows.length === 0) return null;
    const last = rows[rows.length - 1];
    return {
      symbol,
      currency: last.currency,
      exchangeTimezone: last.exchange_timezone,
      source: this.provider.name,
      isMock: last.is_mock,
      closes: rows.map((r) => ({ tradingDate: r.trading_date, close: r.close, closeTime: r.close_time ? new Date(r.close_time).toISOString() : null })),
    };
  }
}
