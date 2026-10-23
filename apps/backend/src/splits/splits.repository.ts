import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { dec } from '../common/decimal';
import { UnitOfWork } from '../database/unit-of-work';
import type { Split } from '../market-prices/market-price.port';
import type { StockSplit, SplitProvenance } from './split-math';

type SplitRow = {
  instrument: string;
  effective_date: string;
  numerator: string;
  denominator: string;
  provenance: SplitProvenance;
  source: string;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type StoredSplit = StockSplit & { createdAt: string; updatedAt: string };

export type SplitConflict = { instrument: string; effectiveDate: string; stored: string; reported: string; source: string };

const SELECT = `SELECT instrument, to_char(effective_date, 'YYYY-MM-DD') AS effective_date, numerator::text AS numerator, denominator::text AS denominator,
                       provenance, source, note, created_at, updated_at
                  FROM security_splits`;

function toSplit(r: SplitRow): StoredSplit {
  return {
    instrument: r.instrument,
    effectiveDate: r.effective_date,
    numerator: dec(r.numerator).toFixed(),
    denominator: dec(r.denominator).toFixed(),
    provenance: r.provenance,
    source: r.source,
    note: r.note,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/**
 * Stock splits and ticker aliases. Market data shared by every user, like
 * the price store, so nothing here is scoped to a user.
 */
@Injectable()
export class SplitsRepository {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * The instrument each symbol belongs to: its alias target, or itself.
   * Readers inside a write transaction pass its manager (PGlite has a single
   * connection, so a query outside the transaction would wait for it).
   */
  async instruments(symbols: readonly string[], manager: EntityManager = this.uow.manager): Promise<Map<string, string>> {
    const result = new Map(symbols.map((s) => [s, s]));
    if (symbols.length === 0) return result;
    const rows: { symbol: string; instrument: string }[] = await manager.query(
      `SELECT symbol, instrument FROM security_symbol_aliases WHERE symbol = ANY($1::varchar[])`,
      [symbols],
    );
    for (const r of rows) result.set(r.symbol, r.instrument);
    return result;
  }

  /** Every symbol that resolves to one of these instruments (the instruments themselves included) */
  async symbolsOf(instruments: readonly string[]): Promise<string[]> {
    if (instruments.length === 0) return [];
    const rows: { symbol: string }[] = await this.uow.manager.query(`SELECT symbol FROM security_symbol_aliases WHERE instrument = ANY($1::varchar[])`, [instruments]);
    return [...new Set([...instruments, ...rows.map((r) => r.symbol)])].sort();
  }

  /** Splits of these instruments, optionally within [from, to] by effective date, ascending */
  async list(filter: { instruments?: readonly string[]; from?: string; to?: string } = {}, manager: EntityManager = this.uow.manager): Promise<StoredSplit[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (filter.instruments) {
      params.push(filter.instruments);
      where.push(`instrument = ANY($${params.length}::varchar[])`);
    }
    if (filter.from) {
      params.push(filter.from);
      where.push(`effective_date >= $${params.length}`);
    }
    if (filter.to) {
      params.push(filter.to);
      where.push(`effective_date <= $${params.length}`);
    }
    const rows: SplitRow[] = await manager.query(
      `${SELECT}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY instrument, effective_date`,
      params,
    );
    return rows.map(toSplit);
  }

  /**
   * Records the splits a provider reported for `symbol` (idempotent). A
   * VERIFIED row is never changed by a provider; a ratio that disagrees with
   * it is returned as a conflict. Returns the effective dates that are new or
   * whose ratio changed: valuations around them need recomputing.
   */
  async recordProviderSplits(symbol: string, source: string, splits: readonly Split[]): Promise<{ instrument: string; changed: string[]; conflicts: SplitConflict[] }> {
    const instrument = (await this.instruments([symbol])).get(symbol)!;
    if (splits.length === 0) return { instrument, changed: [], conflicts: [] };
    return this.uow.run(async (manager) => {
      const changed: string[] = [];
      const conflicts: SplitConflict[] = [];
      for (const split of splits) {
        const [existing]: SplitRow[] = await manager.query(`${SELECT} WHERE instrument = $1 AND effective_date = $2 FOR UPDATE`, [instrument, split.date]);
        const same = existing && dec(existing.numerator).eq(dec(split.numerator)) && dec(existing.denominator).eq(dec(split.denominator));
        if (same) continue;
        if (existing?.provenance === 'VERIFIED') {
          conflicts.push({ instrument, effectiveDate: split.date, stored: `${dec(existing.numerator).toFixed()}:${dec(existing.denominator).toFixed()}`, reported: `${split.numerator}:${split.denominator}`, source });
          continue;
        }
        await manager.query(
          `INSERT INTO security_splits (instrument, effective_date, numerator, denominator, provenance, source) VALUES ($1, $2, $3, $4, 'PROVIDER', $5)
           ON CONFLICT (instrument, effective_date) DO UPDATE SET numerator = EXCLUDED.numerator, denominator = EXCLUDED.denominator,
             source = EXCLUDED.source, updated_at = now()
           WHERE security_splits.provenance = 'PROVIDER'`,
          [instrument, split.date, split.numerator, split.denominator, source],
        );
        changed.push(split.date);
      }
      return { instrument, changed, conflicts };
    });
  }
}
