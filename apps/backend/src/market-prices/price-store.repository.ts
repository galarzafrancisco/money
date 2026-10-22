import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { dec } from '../common/decimal';
import { UnitOfWork } from '../database/unit-of-work';
import type { DailyClose, DailyCloseSeries, Split } from './market-price.port';

export type StoredSeriesMeta = {
  symbol: string;
  source: string;
  currency: string;
  exchangeTimezone: string;
  isMock: boolean;
  adjustment: string;
  /** Every session from coveredFrom to coveredTo is stored (a date with no row had no session) */
  coveredFrom: string;
  coveredTo: string;
  fetchedAt: string;
};

export type StoredClose = DailyClose & { fetchedAt: string };

type MetaRow = {
  symbol: string;
  source: string;
  currency: string;
  exchange_timezone: string;
  is_mock: boolean;
  adjustment: string;
  covered_from: string;
  covered_to: string;
  fetched_at: Date | string;
};

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/**
 * The shared market-price store: closes, splits and which date ranges are
 * known to be complete. Market data, not personal data, so nothing here is
 * scoped to a user. Only closes stored AS_TRADED are ever read back.
 */
@Injectable()
export class PriceStoreRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async meta(symbol: string, source: string): Promise<StoredSeriesMeta | null> {
    const rows: MetaRow[] = await this.uow.manager.query(
      `SELECT symbol, source, currency, exchange_timezone, is_mock, adjustment,
              to_char(covered_from, 'YYYY-MM-DD') AS covered_from, to_char(covered_to, 'YYYY-MM-DD') AS covered_to, fetched_at
         FROM market_price_series WHERE symbol = $1 AND source = $2`,
      [symbol, source],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      symbol: r.symbol,
      source: r.source,
      currency: r.currency,
      exchangeTimezone: r.exchange_timezone,
      isMock: r.is_mock,
      adjustment: r.adjustment,
      coveredFrom: r.covered_from,
      coveredTo: r.covered_to,
      fetchedAt: iso(r.fetched_at)!,
    };
  }

  async closes(symbol: string, source: string, from: string, to: string): Promise<StoredClose[]> {
    const rows: { trading_date: string; close: string; close_time: Date | null; fetched_at: Date }[] = await this.uow.manager.query(
      `SELECT to_char(trading_date, 'YYYY-MM-DD') AS trading_date, close::text AS close, close_time, fetched_at
         FROM market_price_closes
        WHERE symbol = $1 AND source = $2 AND adjustment = 'AS_TRADED' AND trading_date BETWEEN $3 AND $4
        ORDER BY trading_date`,
      [symbol, source, from, to],
    );
    return rows.map((r) => ({ tradingDate: r.trading_date, close: r.close, closeTime: iso(r.close_time), fetchedAt: iso(r.fetched_at)! }));
  }

  /** The latest stored close of a symbol from a source, with its series' currency */
  async latestClose(symbol: string, source: string): Promise<(StoredClose & { currency: string; isMock: boolean }) | null> {
    const rows: { trading_date: string; close: string; close_time: Date | null; fetched_at: Date; currency: string; is_mock: boolean }[] = await this.uow.manager.query(
      `SELECT to_char(trading_date, 'YYYY-MM-DD') AS trading_date, close::text AS close, close_time, fetched_at, currency, is_mock
         FROM market_price_closes
        WHERE symbol = $1 AND source = $2 AND adjustment = 'AS_TRADED'
        ORDER BY trading_date DESC LIMIT 1`,
      [symbol, source],
    );
    const r = rows[0];
    return r ? { tradingDate: r.trading_date, close: r.close, closeTime: iso(r.close_time), fetchedAt: iso(r.fetched_at)!, currency: r.currency, isMock: r.is_mock } : null;
  }

  async splits(symbol: string, source: string, after: string): Promise<Split[]> {
    const rows: { split_date: string; numerator: string; denominator: string }[] = await this.uow.manager.query(
      `SELECT to_char(split_date, 'YYYY-MM-DD') AS split_date, numerator::text AS numerator, denominator::text AS denominator
         FROM market_price_splits WHERE symbol = $1 AND source = $2 AND split_date > $3 ORDER BY split_date`,
      [symbol, source, after],
    );
    return rows.map((r) => ({ date: r.split_date, numerator: dec(r.numerator).toString(), denominator: dec(r.denominator).toString() }));
  }

  /**
   * Stores what one provider request returned, in one transaction: upserts
   * the closes and splits, and extends the covered range by `covered`
   * (merged when it touches the stored range, else replacing it). Returns the
   * trading dates whose stored close changed value: corrections that
   * invalidate valuations computed from the old close.
   */
  async saveFetch(series: DailyCloseSeries, covered: { from: string; to: string } | null): Promise<string[]> {
    return this.uow.run(async (manager) => {
      // Serialises writers of one series across processes; harmless when they agree
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`market_price_series:${series.source}:${series.symbol}`]);
      const existingMeta = await manager.query(`SELECT currency FROM market_price_series WHERE symbol = $1 AND source = $2`, [series.symbol, series.source]);
      if (existingMeta[0] && existingMeta[0].currency !== series.currency) {
        // The provider changed the series' currency: what is stored is no longer comparable
        await manager.query(`DELETE FROM market_price_series WHERE symbol = $1 AND source = $2`, [series.symbol, series.source]);
        await manager.query(`DELETE FROM market_price_closes WHERE symbol = $1 AND source = $2`, [series.symbol, series.source]);
      }
      const changed = await this.upsertCloses(manager, series);
      for (const split of series.splits) {
        await manager.query(
          `INSERT INTO market_price_splits (symbol, source, split_date, numerator, denominator) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (symbol, source, split_date) DO UPDATE SET numerator = EXCLUDED.numerator, denominator = EXCLUDED.denominator, fetched_at = now()`,
          [series.symbol, series.source, split.date, split.numerator, split.denominator],
        );
      }
      if (covered && covered.from <= covered.to) {
        await manager.query(
          `INSERT INTO market_price_series AS s (symbol, source, currency, exchange_timezone, is_mock, adjustment, covered_from, covered_to)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (symbol, source) DO UPDATE SET
             currency = EXCLUDED.currency, exchange_timezone = EXCLUDED.exchange_timezone, is_mock = EXCLUDED.is_mock,
             adjustment = EXCLUDED.adjustment, fetched_at = now(),
             covered_from = CASE WHEN EXCLUDED.covered_from <= s.covered_to + 1 AND EXCLUDED.covered_to >= s.covered_from - 1
                                 THEN LEAST(s.covered_from, EXCLUDED.covered_from) ELSE EXCLUDED.covered_from END,
             covered_to = CASE WHEN EXCLUDED.covered_from <= s.covered_to + 1 AND EXCLUDED.covered_to >= s.covered_from - 1
                               THEN GREATEST(s.covered_to, EXCLUDED.covered_to) ELSE EXCLUDED.covered_to END`,
          [series.symbol, series.source, series.currency, series.exchangeTimezone, series.isMock, series.adjustment, covered.from, covered.to],
        );
      }
      return changed;
    });
  }

  /** Forgets that dates from `fromDate` are stored, so the next lookup fetches them again (and spots corrections) */
  async forgetCoverageFrom(symbol: string, source: string, fromDate: string): Promise<void> {
    await this.uow.run(async (manager) => {
      await manager.query(`DELETE FROM market_price_series WHERE symbol = $1 AND source = $2 AND covered_from >= $3`, [symbol, source, fromDate]);
      await manager.query(`UPDATE market_price_series SET covered_to = $3::date - 1 WHERE symbol = $1 AND source = $2 AND covered_to >= $3`, [symbol, source, fromDate]);
    });
  }

  private async upsertCloses(manager: EntityManager, series: DailyCloseSeries): Promise<string[]> {
    if (series.closes.length === 0) return [];
    const from = series.closes[0].tradingDate;
    const to = series.closes[series.closes.length - 1].tradingDate;
    const before: { trading_date: string; close: string }[] = await manager.query(
      `SELECT to_char(trading_date, 'YYYY-MM-DD') AS trading_date, close::text AS close
         FROM market_price_closes WHERE symbol = $1 AND source = $2 AND trading_date BETWEEN $3 AND $4`,
      [series.symbol, series.source, from, to],
    );
    const old = new Map(before.map((r) => [r.trading_date, r.close]));
    const changed = series.closes.filter((c) => old.has(c.tradingDate) && !dec(old.get(c.tradingDate)!).equals(dec(c.close))).map((c) => c.tradingDate);

    // In batches, to stay well under the bind-parameter limit
    for (let start = 0; start < series.closes.length; start += 500) {
      const batch = series.closes.slice(start, start + 500);
      const values: unknown[] = [];
      const rows = batch.map((close, i) => {
        values.push(series.symbol, series.source, close.tradingDate, close.close, series.currency, series.exchangeTimezone, close.closeTime, series.isMock, series.adjustment);
        const p = i * 9;
        return `($${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7}, $${p + 8}, $${p + 9})`;
      });
      await manager.query(
        `INSERT INTO market_price_closes AS c (symbol, source, trading_date, close, currency, exchange_timezone, close_time, is_mock, adjustment)
         VALUES ${rows.join(', ')}
         ON CONFLICT (symbol, source, trading_date) DO UPDATE SET
           revised_at = CASE WHEN c.close <> EXCLUDED.close THEN now() ELSE c.revised_at END,
           close = EXCLUDED.close, currency = EXCLUDED.currency, exchange_timezone = EXCLUDED.exchange_timezone,
           close_time = EXCLUDED.close_time, is_mock = EXCLUDED.is_mock, adjustment = EXCLUDED.adjustment, fetched_at = now()`,
        values,
      );
    }
    return changed;
  }
}
