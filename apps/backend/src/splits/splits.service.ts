import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { fmt } from '../common/decimal';
import { parseInput } from '../common/validation';
import type { LedgerEntry } from '../ledger/ledger.types';
import { toLedgerEntry } from '../transactions/transaction.mapper';
import type { TransactionEntity } from '../transactions/transaction.entity';
import { factorAfter, ratioOf, recordedOn, splitsAfter, toPresentBasis, type SplitIndex, type StockSplit } from './split-math';
import { listSplitsSchema, splitAdjustmentSchema, type ListSplitsInput, type SplitAdjustmentInput } from './splits.schemas';
import { SplitsRepository, type StoredSplit } from './splits.repository';

export type SplitView = {
  instrument: string;
  effectiveDate: string;
  numerator: string;
  denominator: string;
  /** numerator ÷ denominator: shares after the split per share before it */
  ratio: string;
  provenance: StockSplit['provenance'];
  source: string;
  note: string | null;
  /** The symbols this split applies to: the instrument and its old tickers */
  symbols: string[];
  /**
   * What the split does to an unchanged position on its effective date:
   * shares × ratio, and the as-traded close ÷ ratio. Market value is
   * unchanged absent market movement.
   */
  explanation: string;
  createdAt: string;
  updatedAt: string;
};

const NOTES = [
  'A split numerator:denominator effective (ex-date) E turns each share held at the end of the previous day into numerator/denominator shares from E on; as-traded closes drop by the same ratio, so market value is unchanged absent market movement.',
  'Transactions are never rewritten. Each trade\'s quantity is read in the share basis of the day it was recorded (createdAt), and lots, cost bases and holdings are replayed in the present basis (every known split applied). A valuation of date D shows the quantity held at the end of D in D\'s own basis, valued at D\'s as-traded close.',
  'provenance VERIFIED: checked and recorded by hand; it always wins. PROVIDER: reported by the price provider with its closes.',
  'Tracking aid only, not tax advice: corporate actions can have tax consequences this does not assess.',
];

const ADJUSTMENT_NOTES = [
  'presentQuantity = quantity in date\'s basis × factor; presentBasisPrice = as-traded price on date ÷ factor. factor 1 means no split after date.',
  'Holdings and lots (list_lots, get_portfolio) are in the present basis; get_valuation_history and get_valuation_as_of report each date in that date\'s basis (holding.split shows the factor used).',
  'Tracking aid only, not tax advice.',
];

/**
 * Stock splits: the split index the ledger and valuations use, and the
 * read-only views behind REST and MCP. See docs/stock-splits.md.
 */
@Injectable()
export class SplitsService {
  constructor(private readonly repo: SplitsRepository) {}

  /**
   * Splits for each of these ledger symbols, aliases resolved; symbols
   * without any are left out. Inside a write transaction, pass its manager.
   */
  async index(symbols: Iterable<string>, manager?: EntityManager): Promise<SplitIndex> {
    const unique = [...new Set(symbols)];
    if (unique.length === 0) return new Map();
    const instruments = await this.repo.instruments(unique, manager);
    const splits = await this.repo.list({ instruments: [...new Set(instruments.values())] }, manager);
    const index = new Map<string, StockSplit[]>();
    for (const symbol of unique) {
      const own = splits.filter((s) => s.instrument === instruments.get(symbol));
      if (own.length > 0) index.set(symbol, own);
    }
    return index;
  }

  /**
   * Ledger entries in the present share basis: each trade read in the basis
   * of the day it was recorded and converted with the splits since. Every
   * replay goes through this, so lots, sales and valuations count the same
   * shares. With no split involved the entries are returned as they are.
   */
  async presentEntries(rows: readonly TransactionEntity[], options: { now?: Date; manager?: EntityManager } = {}): Promise<LedgerEntry[]> {
    const index = await this.index(rows.filter((r) => r.symbol && (r.type === 'BUY' || r.type === 'SELL')).map((r) => r.symbol!), options.manager);
    return this.presentEntriesWith(rows, index, options.now);
  }

  /** As presentEntries, with an index already loaded */
  presentEntriesWith(rows: readonly TransactionEntity[], index: SplitIndex, now: Date = new Date()): LedgerEntry[] {
    const today = now.toISOString().slice(0, 10);
    const basis = new Map(rows.map((r) => [r.id, recordedOn(r.createdAt, today)]));
    return toPresentBasis(rows.map(toLedgerEntry), index, (id) => basis.get(id) ?? today);
  }

  async list(input: ListSplitsInput = {}) {
    const options = parseInput(listSplitsSchema, input);
    const instrument = options.symbol ? (await this.repo.instruments([options.symbol])).get(options.symbol)! : null;
    const splits = await this.repo.list({ instruments: instrument ? [instrument] : undefined, from: options.fromDate, to: options.toDate });
    const views = await this.views(splits);
    return {
      symbol: options.symbol ?? null,
      instrument,
      fromDate: options.fromDate ?? null,
      toDate: options.toDate ?? null,
      splits: views,
      notes: NOTES,
    };
  }

  /** The cumulative factor from a date's share basis to the present one, and the splits that make it up */
  async adjustment(input: SplitAdjustmentInput) {
    const options = parseInput(splitAdjustmentSchema, input);
    const instrument = (await this.repo.instruments([options.symbol])).get(options.symbol)!;
    const all = await this.repo.list({ instruments: [instrument] });
    const after = splitsAfter(all, options.date);
    const factor = factorAfter(all, options.date);
    return {
      symbol: options.symbol,
      instrument,
      symbols: await this.repo.symbolsOf([instrument]),
      date: options.date,
      factor: fmt(factor),
      splitsAfterDate: await this.views(after),
      splitsOnOrBeforeDate: await this.views(all.filter((s) => s.effectiveDate <= options.date)),
      description:
        after.length === 0
          ? `No ${instrument} split is recorded after ${options.date}: quantities and prices on that date are already in the present basis.`
          : `${after.length} split(s) after ${options.date} (${after.map((s) => `${s.numerator}:${s.denominator} on ${s.effectiveDate}`).join(', ')}): 1 share held on ${options.date} is ${fmt(factor)} shares now, and a price on ${options.date} is ${fmt(factor)} times its present-basis equivalent.`,
      notes: ADJUSTMENT_NOTES,
    };
  }

  private async views(splits: readonly StoredSplit[]): Promise<SplitView[]> {
    const symbols = new Map<string, string[]>();
    for (const instrument of new Set(splits.map((s) => s.instrument))) symbols.set(instrument, await this.repo.symbolsOf([instrument]));
    return splits.map((s) => ({
      instrument: s.instrument,
      effectiveDate: s.effectiveDate,
      numerator: s.numerator,
      denominator: s.denominator,
      ratio: fmt(ratioOf(s)),
      provenance: s.provenance,
      source: s.source,
      note: s.note,
      symbols: symbols.get(s.instrument) ?? [s.instrument],
      explanation: `From ${s.effectiveDate}, each ${s.instrument} share held is ${fmt(ratioOf(s))} shares and the as-traded price is divided by ${fmt(ratioOf(s))}; value is unchanged absent market movement.`,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }
}
