import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { UnitOfWork } from '../database/unit-of-work';
import type { PriceStatus } from './valuation-math';

export type DayStatus = 'COMPLETE' | 'PARTIAL';

export type ValuationDayRow = {
  date: string;
  status: DayStatus;
  priceProvider: string;
  holdingsCount: number;
  computedAt: Date;
};

export type LotSnapshot = { lotId: string; acquiredOn: string; quantity: string; costBase: string; marketValue: string | null };

export type ValuationHoldingRow = {
  date: string;
  accountId: string;
  symbol: string;
  currency: string;
  quantity: string;
  costBase: string;
  priceStatus: PriceStatus;
  closePrice: string | null;
  priceCurrency: string | null;
  priceDate: string | null;
  priceCloseTime: string | null;
  priceSource: string | null;
  priceIsMock: boolean | null;
  exchangeTimezone: string | null;
  marketValue: string | null;
  priceNote: string | null;
  lots: LotSnapshot[];
};

/**
 * requestedAt is the exact text, used to clear or checkpoint the request only
 * if it was not renewed meanwhile. recomputedFrom: dates from it onwards are
 * already re-valued for this request (null: none yet).
 */
export type RecomputeRequest = { accountId: string; fromDate: string; requestedAt: string; recomputedFrom: string | null };

export type MissingPriceSymbol = { symbol: string; days: number; firstDate: string; lastDate: string };

export type JobState = {
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  lastSummary: unknown;
};

const DATE = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

/**
 * Storage for the daily valuation job. Every method that reads or writes a
 * user's valuations takes the user id and filters by it.
 */
@Injectable()
export class ValuationsRepository {
  constructor(private readonly uow: UnitOfWork) {}

  private get db() {
    return this.uow.manager;
  }

  /** Users who have (or had) something to value */
  async usersToProcess(): Promise<string[]> {
    const rows: { user_id: string }[] = await this.db.query(
      `SELECT user_id FROM transactions WHERE type = 'BUY'
       UNION SELECT user_id FROM valuation_recompute_requests
       UNION SELECT user_id FROM valuation_days`,
    );
    return rows.map((r) => r.user_id).sort();
  }

  async userExists(userId: string): Promise<boolean> {
    const rows: unknown[] = await this.db.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
    return rows.length > 0;
  }

  async listDays(userId: string, from: string, to: string): Promise<ValuationDayRow[]> {
    const rows: { date: string; status: DayStatus; price_provider: string; holdings_count: number; computed_at: Date }[] = await this.db.query(
      `SELECT ${DATE('valuation_date')} AS date, status, price_provider, holdings_count, computed_at
         FROM valuation_days WHERE user_id = $1 AND valuation_date BETWEEN $2 AND $3 ORDER BY valuation_date`,
      [userId, from, to],
    );
    return rows.map((r) => ({ date: r.date, status: r.status, priceProvider: r.price_provider, holdingsCount: Number(r.holdings_count), computedAt: new Date(r.computed_at) }));
  }

  async listHoldings(userId: string, from: string, to: string, filter: { accountIds?: string[]; symbol?: string } = {}): Promise<ValuationHoldingRow[]> {
    const params: unknown[] = [userId, from, to];
    let where = 'user_id = $1 AND valuation_date BETWEEN $2 AND $3';
    if (filter.accountIds) {
      params.push(filter.accountIds);
      where += ` AND account_id = ANY($${params.length}::uuid[])`;
    }
    if (filter.symbol) {
      params.push(filter.symbol);
      where += ` AND symbol = $${params.length}`;
    }
    const rows: Record<string, unknown>[] = await this.db.query(
      `SELECT ${DATE('valuation_date')} AS date, account_id, symbol, currency, quantity::text AS quantity, cost_base::text AS cost_base,
              price_status, close_price::text AS close_price, price_currency, ${DATE('price_date')} AS price_date, price_close_time,
              price_source, price_is_mock, exchange_timezone, market_value::text AS market_value, price_note, lots
         FROM valuation_holdings WHERE ${where}
        ORDER BY valuation_date, account_id, symbol`,
      params,
    );
    return rows.map((r) => ({
      date: r.date as string,
      accountId: r.account_id as string,
      symbol: r.symbol as string,
      currency: r.currency as string,
      quantity: r.quantity as string,
      costBase: r.cost_base as string,
      priceStatus: r.price_status as PriceStatus,
      closePrice: (r.close_price as string | null) ?? null,
      priceCurrency: (r.price_currency as string | null) ?? null,
      priceDate: (r.price_date as string | null) ?? null,
      priceCloseTime: r.price_close_time ? new Date(r.price_close_time as string).toISOString() : null,
      priceSource: (r.price_source as string | null) ?? null,
      priceIsMock: (r.price_is_mock as boolean | null) ?? null,
      exchangeTimezone: (r.exchange_timezone as string | null) ?? null,
      marketValue: (r.market_value as string | null) ?? null,
      priceNote: (r.price_note as string | null) ?? null,
      lots: (typeof r.lots === 'string' ? JSON.parse(r.lots) : r.lots) as LotSnapshot[],
    }));
  }

  /**
   * Replaces one user's valuation of one date, atomically: the day and its
   * holdings are deleted and written again in one transaction, so re-running
   * never duplicates rows and readers never see half a day.
   */
  async replaceDay(
    userId: string,
    day: { date: string; status: DayStatus; priceProvider: string },
    holdings: Omit<ValuationHoldingRow, 'date'>[],
  ): Promise<void> {
    await this.uow.run(async (manager) => {
      await manager.query(`DELETE FROM valuation_days WHERE user_id = $1 AND valuation_date = $2`, [userId, day.date]);
      await manager.query(
        `INSERT INTO valuation_days (user_id, valuation_date, status, price_provider, holdings_count, computed_at) VALUES ($1, $2, $3, $4, $5, now())`,
        [userId, day.date, day.status, day.priceProvider, holdings.length],
      );
      for (let start = 0; start < holdings.length; start += 200) {
        const chunk = holdings.slice(start, start + 200);
        const values: unknown[] = [];
        const tuples = chunk.map((h, i) => {
          values.push(
            randomUUID(), userId, day.date, h.accountId, h.symbol, h.currency, h.quantity, h.costBase, h.priceStatus, h.closePrice,
            h.priceCurrency, h.priceDate, h.priceCloseTime, h.priceSource, h.priceIsMock, h.exchangeTimezone, h.marketValue, h.priceNote,
            JSON.stringify(h.lots),
          );
          const p = i * 19;
          return `(${Array.from({ length: 19 }, (_, k) => `$${p + k + 1}`).join(', ')})`;
        });
        await manager.query(
          `INSERT INTO valuation_holdings (id, user_id, valuation_date, account_id, symbol, currency, quantity, cost_base, price_status, close_price,
             price_currency, price_date, price_close_time, price_source, price_is_mock, exchange_timezone, market_value, price_note, lots)
           VALUES ${tuples.join(', ')}`,
          values,
        );
      }
    });
  }

  /** Removes days the ledger no longer covers (e.g. before the first purchase after a backdated delete) */
  async deleteDaysBefore(userId: string, date: string | null): Promise<number> {
    const result = date
      ? await this.db.query(`DELETE FROM valuation_days WHERE user_id = $1 AND valuation_date < $2`, [userId, date])
      : await this.db.query(`DELETE FROM valuation_days WHERE user_id = $1`, [userId]);
    return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
  }

  async recomputeRequests(userId: string): Promise<RecomputeRequest[]> {
    const rows: { account_id: string; from_date: string; requested_at: string; recomputed_from: string | null }[] = await this.db.query(
      `SELECT account_id, ${DATE('from_date')} AS from_date, requested_at::text AS requested_at,
              CASE WHEN checkpoint_for = requested_at THEN ${DATE('recomputed_from')} END AS recomputed_from
         FROM valuation_recompute_requests WHERE user_id = $1 ORDER BY from_date`,
      [userId],
    );
    return rows.map((r) => ({ accountId: r.account_id, fromDate: r.from_date, requestedAt: r.requested_at, recomputedFrom: r.recomputed_from ?? null }));
  }

  /** Clears the requests handled, unless one was renewed meanwhile (then it stays for the next run) */
  async clearRequests(userId: string, requests: readonly RecomputeRequest[]): Promise<void> {
    for (const request of requests) {
      await this.db.query(
        `DELETE FROM valuation_recompute_requests WHERE user_id = $1 AND account_id = $2 AND requested_at = $3::timestamptz`,
        [userId, request.accountId, request.requestedAt],
      );
    }
  }

  /** Records how far a request has got, unless it was renewed meanwhile (then the checkpoint is void) */
  async checkpointRequest(userId: string, request: RecomputeRequest, recomputedFrom: string): Promise<void> {
    await this.db.query(
      `UPDATE valuation_recompute_requests SET recomputed_from = $4, checkpoint_for = requested_at
        WHERE user_id = $1 AND account_id = $2 AND requested_at = $3::timestamptz`,
      [userId, request.accountId, request.requestedAt, recomputedFrom],
    );
  }

  /**
   * A shared close of `symbol` changed (a provider correction found by a
   * refresh): every account, of any user, that has traded the symbol is
   * re-valued from that date. System-initiated; nothing is returned to anyone.
   */
  async requestRecomputeForSymbol(symbol: string, fromDate: string): Promise<void> {
    await this.db.query(
      `INSERT INTO valuation_recompute_requests (account_id, user_id, from_date, requested_at)
       SELECT DISTINCT account_id, user_id, $2::date, clock_timestamp() FROM transactions WHERE symbol = $1 AND type IN ('BUY', 'SELL')
       ON CONFLICT (account_id) DO UPDATE SET from_date = LEAST(valuation_recompute_requests.from_date, EXCLUDED.from_date), requested_at = EXCLUDED.requested_at`,
      [symbol, fromDate],
    );
  }

  /** Asks for every one of the user's accounts to be re-valued from a date */
  async requestRecompute(userId: string, accountIds: readonly string[], fromDate: string): Promise<void> {
    for (const accountId of accountIds) {
      await this.db.query(
        `INSERT INTO valuation_recompute_requests (account_id, user_id, from_date, requested_at) VALUES ($1, $2, $3, clock_timestamp())
         ON CONFLICT (account_id) DO UPDATE SET from_date = LEAST(valuation_recompute_requests.from_date, EXCLUDED.from_date), requested_at = EXCLUDED.requested_at
         WHERE valuation_recompute_requests.user_id = EXCLUDED.user_id`,
        [accountId, userId, fromDate],
      );
    }
  }

  async daysSummary(userId: string): Promise<{ earliest: string | null; latest: string | null; days: number; partialDays: number }> {
    const rows: { earliest: string | null; latest: string | null; days: string; partial: string }[] = await this.db.query(
      `SELECT ${DATE('MIN(valuation_date)')} AS earliest, ${DATE('MAX(valuation_date)')} AS latest, COUNT(*) AS days,
              COUNT(*) FILTER (WHERE status = 'PARTIAL') AS partial
         FROM valuation_days WHERE user_id = $1`,
      [userId],
    );
    const r = rows[0];
    return { earliest: r?.earliest ?? null, latest: r?.latest ?? null, days: Number(r?.days ?? 0), partialDays: Number(r?.partial ?? 0) };
  }

  /** The database clock, which stamps snapshots' computed_at */
  async now(): Promise<Date> {
    const rows: { ms: string | number }[] = await this.db.query(`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`);
    return new Date(Math.floor(Number(rows[0].ms)));
  }

  /** The date of the user's first purchase: where the valuation history has to start */
  async firstPurchaseDate(userId: string): Promise<string | null> {
    const rows: { first: string | null }[] = await this.db.query(
      `SELECT ${DATE('MIN(date)')} AS first FROM transactions WHERE user_id = $1 AND type = 'BUY'`,
      [userId],
    );
    return rows[0]?.first ?? null;
  }

  /** Counts of the user's snapshots inside [from, to] */
  async coverageCounts(userId: string, from: string, to: string, priceProvider: string): Promise<{ days: number; partialDays: number; otherProviderDays: number }> {
    const rows: { days: string; partial: string; other: string }[] = await this.db.query(
      `SELECT COUNT(*) AS days, COUNT(*) FILTER (WHERE status = 'PARTIAL') AS partial, COUNT(*) FILTER (WHERE price_provider <> $4) AS other
         FROM valuation_days WHERE user_id = $1 AND valuation_date BETWEEN $2 AND $3`,
      [userId, from, to, priceProvider],
    );
    const r = rows[0];
    return { days: Number(r?.days ?? 0), partialDays: Number(r?.partial ?? 0), otherProviderDays: Number(r?.other ?? 0) };
  }

  /** Symbols the user's snapshots could not value (MISSING or CURRENCY_MISMATCH), with the dates affected */
  async missingPriceSymbols(userId: string): Promise<MissingPriceSymbol[]> {
    const rows: { symbol: string; days: string; first_date: string; last_date: string }[] = await this.db.query(
      `SELECT symbol, COUNT(DISTINCT valuation_date) AS days, ${DATE('MIN(valuation_date)')} AS first_date, ${DATE('MAX(valuation_date)')} AS last_date
         FROM valuation_holdings WHERE user_id = $1 AND price_status IN ('MISSING', 'CURRENCY_MISMATCH')
        GROUP BY symbol ORDER BY symbol`,
      [userId],
    );
    return rows.map((r) => ({ symbol: r.symbol, days: Number(r.days), firstDate: r.first_date, lastDate: r.last_date }));
  }

  // ── Job lease ─────────────────────────────────────────────────────────────

  /** Takes the job lease if nobody holds an unexpired one */
  async acquireLease(owner: string, minutes: number): Promise<boolean> {
    const rows: unknown[] = await this.db.query(
      `UPDATE valuation_job_state
          SET lease_owner = $1, lease_expires_at = now() + make_interval(mins => $2), last_started_at = now()
        WHERE id = 1 AND (lease_expires_at IS NULL OR lease_expires_at < now() OR lease_owner = $1)
        RETURNING id`,
      [owner, minutes],
    );
    return flatRows(rows).length > 0;
  }

  async releaseLease(owner: string, outcome: { status: 'ok' | 'partial' | 'failed'; error: string | null; summary: unknown }): Promise<void> {
    await this.db.query(
      `UPDATE valuation_job_state
          SET lease_owner = NULL, lease_expires_at = NULL, last_finished_at = now(), last_status = $2, last_error = $3, last_summary = $4
        WHERE id = 1 AND lease_owner = $1`,
      [owner, outcome.status, outcome.error, JSON.stringify(outcome.summary)],
    );
  }

  async jobState(): Promise<JobState | null> {
    const rows: Record<string, unknown>[] = await this.db.query(`SELECT * FROM valuation_job_state WHERE id = 1`);
    const r = rows[0];
    if (!r) return null;
    const date = (v: unknown) => (v ? new Date(v as string) : null);
    return {
      leaseOwner: (r.lease_owner as string | null) ?? null,
      leaseExpiresAt: date(r.lease_expires_at),
      lastStartedAt: date(r.last_started_at),
      lastFinishedAt: date(r.last_finished_at),
      lastStatus: (r.last_status as string | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      lastSummary: typeof r.last_summary === 'string' ? JSON.parse(r.last_summary) : (r.last_summary ?? null),
    };
  }
}

/** TypeORM's postgres driver returns [rows, count] for UPDATE … RETURNING */
function flatRows(result: unknown[]): unknown[] {
  return Array.isArray(result[0]) ? (result[0] as unknown[]) : result;
}
