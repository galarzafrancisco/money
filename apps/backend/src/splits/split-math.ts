/**
 * Pure stock-split arithmetic. No I/O. See docs/stock-splits.md.
 *
 * Share bases: a split effective (ex-date) E with ratio n:d turns every share
 * held at the end of E-1 into n/d shares from E on. A quantity "in the basis
 * of date B" counts shares as they stood at the end of B (every split with
 * E <= B applied). The PRESENT basis has every known split applied.
 *
 * - Ledger quantities are read in the basis of the day each transaction was
 *   recorded, and normalised to the present basis before replay, so lots,
 *   cost bases and sales all count the same shares.
 * - A valuation of date D converts present-basis quantities back to D's
 *   basis, so they can be multiplied by D's as-traded close.
 */
import { MoneyDecimal, dec, toStored } from '../common/decimal';
import type { LedgerEntry, Position } from '../ledger/ledger.types';

export type SplitProvenance = 'VERIFIED' | 'PROVIDER';

export type StockSplit = {
  /** The instrument the split belongs to (the canonical ticker; aliases resolve to it) */
  instrument: string;
  /** Ex-date (YYYY-MM-DD): the first trading date in the new basis */
  effectiveDate: string;
  /** One share before the split became numerator/denominator shares */
  numerator: string;
  denominator: string;
  /** VERIFIED: checked and recorded by hand (wins). PROVIDER: reported by a price provider. */
  provenance: SplitProvenance;
  /** Where it came from: a provider name, or e.g. "migration" */
  source: string;
  note: string | null;
};

/** Splits per ledger symbol (aliases already resolved), ascending by effective date */
export type SplitIndex = ReadonlyMap<string, readonly StockSplit[]>;

export const NO_SPLITS: SplitIndex = new Map();

export const ONE = dec(1);

export function ratioOf(split: Pick<StockSplit, 'numerator' | 'denominator'>): MoneyDecimal {
  return dec(split.numerator).dividedBy(split.denominator);
}

/** Splits effective after `date` (not on it): what turns a quantity in `date`'s basis into the present basis */
export function splitsAfter<T extends StockSplit>(splits: readonly T[] | undefined, date: string): T[] {
  return (splits ?? []).filter((s) => s.effectiveDate > date);
}

/** Splits effective in (from, to]: what turns a quantity in `from`'s basis into `to`'s */
export function splitsBetween<T extends StockSplit>(splits: readonly T[] | undefined, from: string, to: string): T[] {
  return (splits ?? []).filter((s) => s.effectiveDate > from && s.effectiveDate <= to);
}

/**
 * Cumulative factor from `date`'s basis to the present basis: the product of
 * the ratios of every split effective after `date`. 1 when there is none.
 * present quantity = quantity on date × factor; present-basis price = price on date ÷ factor.
 */
export function factorAfter(splits: readonly StockSplit[] | undefined, date: string): MoneyDecimal {
  return splitsAfter(splits, date).reduce((f, s) => f.times(ratioOf(s)), ONE);
}

/** Quantities keep the stored scale; exact for whole-number ratios */
function scaled(value: MoneyDecimal, factor: MoneyDecimal): MoneyDecimal {
  return factor.eq(1) ? value : toStored(value.times(factor));
}

function divided(value: MoneyDecimal, factor: MoneyDecimal): MoneyDecimal {
  return factor.eq(1) ? value : toStored(value.dividedBy(factor));
}

/**
 * Ledger entries with every trade's quantity (and a specific sale's lot
 * allocations) converted from the basis of the day it was recorded to the
 * present basis. Prices are divided by the same factor; totals, fees and
 * cash are untouched, so cost bases and proceeds stay what was paid.
 * `basisDateOf` gives each entry's basis date (the day it was recorded).
 */
export function toPresentBasis(entries: readonly LedgerEntry[], index: SplitIndex, basisDateOf: (entryId: string) => string): LedgerEntry[] {
  if (index.size === 0) return [...entries];
  return entries.map((entry) => {
    if (entry.type !== 'BUY' && entry.type !== 'SELL') return entry;
    const factor = factorAfter(index.get(entry.symbol), basisDateOf(entry.id));
    if (factor.eq(1)) return entry;
    return {
      ...entry,
      quantity: scaled(entry.quantity, factor),
      unitPrice: divided(entry.unitPrice, factor),
      ...(entry.allocations ? { allocations: entry.allocations.map((a) => ({ ...a, quantity: scaled(a.quantity, factor) })) } : {}),
    };
  });
}

/**
 * A present-basis position expressed in the share basis of `date`: what was
 * really held at the end of that day, comparable with its as-traded close.
 * Cost bases do not change. `factor` is the cumulative factor to the present
 * basis (1: no split since `date`).
 */
export function positionOnDate(position: Position, splits: readonly StockSplit[] | undefined, date: string): Position & { factor: MoneyDecimal; presentQuantity: MoneyDecimal } {
  const factor = factorAfter(splits, date);
  return {
    ...position,
    factor,
    presentQuantity: position.quantity,
    quantity: divided(position.quantity, factor),
    lots: position.lots.map((lot) => ({
      ...lot,
      originalQuantity: divided(lot.originalQuantity, factor),
      remainingQuantity: divided(lot.remainingQuantity, factor),
    })),
  };
}

/** Whether two indexes hold the same splits (e.g. a price lookup just recorded a new one) */
export function sameSplits(a: SplitIndex, b: SplitIndex): boolean {
  const key = (index: SplitIndex) =>
    JSON.stringify([...index.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([symbol, list]) => [symbol, list.map((s) => [s.effectiveDate, s.numerator, s.denominator])]));
  return key(a) === key(b);
}

/** The basis date of a transaction: the UTC date it was recorded. A row being written now has no createdAt yet. */
export function recordedOn(createdAt: Date | undefined | null, today: string): string {
  return createdAt ? createdAt.toISOString().slice(0, 10) : today;
}
