import { MoneyDecimal, ZERO, fmt, toStored } from '../common/decimal';
import { LedgerViolationError } from '../common/errors';
import type { DividendEntry, DividendTotals, Disposal, LedgerEntry, LedgerState, Lot, LotSelection, Position, TradeEntry } from './ledger.types';

export function compareEntries(a: Pick<LedgerEntry, 'date' | 'sequence'>, b: Pick<LedgerEntry, 'date' | 'sequence'>): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.sequence - b.sequence;
}

/**
 * Replays an account's transactions in (date, sequence) order and derives
 * everything else: cash per currency, open lots, positions, realized gains
 * and dividend totals. Nothing derived is stored, so edits and deletes can
 * never leave stale balances.
 *
 * Throws LedgerViolationError at the first entry that would make cash
 * negative, sell more shares than are held, or trade a ticker in a second
 * currency.
 *
 * Lot matching: a sale with allocations consumes exactly the lots and
 * quantities it names (specific identification), checked against what each
 * lot still held at that point of the replay. A sale without allocations
 * consumes the oldest open lots first (FIFO). Explicit allocations are never
 * re-matched: if an earlier change leaves them impossible, replay throws.
 */
export type ReplayOptions = {
  /**
   * Don't stop at negative cash. Only for read-only previews of lots (e.g.
   * the lots a sale being edited could use, with that sale left out), never
   * for validating a write.
   */
  ignoreCash?: boolean;
};

export function replayLedger(entries: readonly LedgerEntry[], options: ReplayOptions = {}): LedgerState {
  const sorted = [...entries].sort(compareEntries);
  const cash = new Map<string, MoneyDecimal>();
  const lotsBySymbol = new Map<string, Lot[]>();
  const lotsById = new Map<string, Lot>();
  const laterBuys = new Map<string, TradeEntry>();
  for (const entry of sorted) if (entry.type === 'BUY') laterBuys.set(entry.id, entry);
  const symbolCurrency = new Map<string, string>();
  const disposals: Disposal[] = [];
  const dividends = new Map<string, DividendTotals>();
  const dividendsBySymbol = new Map<string, DividendTotals & { symbol: string }>();

  const credit = (currency: string, amount: MoneyDecimal) => {
    cash.set(currency, (cash.get(currency) ?? ZERO).plus(amount));
  };
  const debit = (entry: LedgerEntry, currency: string, amount: MoneyDecimal) => {
    const balance = (cash.get(currency) ?? ZERO).minus(amount);
    if (balance.lt(0) && !options.ignoreCash) {
      throw new LedgerViolationError(
        `Not enough ${currency} cash on ${entry.date}: this ${describe(entry)} needs ${fmt(amount)} ${currency} but the balance is ${fmt(balance.plus(amount))} ${currency}. Record the deposit or conversion that funded it first, or check its date.`,
        { transactionId: entry.id, currency, required: fmt(amount), available: fmt(balance.plus(amount)) },
      );
    }
    cash.set(currency, balance);
  };
  const checkCurrency = (entry: TradeEntry) => {
    const existing = symbolCurrency.get(entry.symbol);
    if (existing && existing !== entry.currency) {
      throw new LedgerViolationError(
        `${entry.symbol} is traded in ${existing} in this account, so a ${entry.type.toLowerCase()} in ${entry.currency} is not allowed`,
        { transactionId: entry.id, symbol: entry.symbol, currency: entry.currency, expectedCurrency: existing },
      );
    }
    symbolCurrency.set(entry.symbol, entry.currency);
  };

  for (const entry of sorted) {
    switch (entry.type) {
      case 'DEPOSIT':
        credit(entry.currency, entry.amount);
        break;
      case 'WITHDRAWAL':
        debit(entry, entry.currency, entry.amount);
        break;
      case 'TRANSFER_OUT':
        debit(entry, entry.currency, entry.amount.plus(entry.fees));
        break;
      case 'TRANSFER_IN':
        credit(entry.currency, entry.amount);
        break;
      case 'FX_CONVERSION':
        debit(entry, entry.fromCurrency, entry.fromAmount.plus(entry.fees));
        credit(entry.toCurrency, entry.toAmount);
        break;
      case 'BUY': {
        checkCurrency(entry);
        debit(entry, entry.currency, entry.total);
        const lots = lotsBySymbol.get(entry.symbol) ?? [];
        const lot: Lot = {
          lotId: entry.id,
          sequence: entry.sequence,
          symbol: entry.symbol,
          currency: entry.currency,
          acquiredOn: entry.date,
          originalQuantity: entry.quantity,
          originalCostBase: entry.total,
          remainingQuantity: entry.quantity,
          remainingCostBase: entry.total,
        };
        lots.push(lot);
        lotsById.set(lot.lotId, lot);
        laterBuys.delete(entry.id);
        lotsBySymbol.set(entry.symbol, lots);
        break;
      }
      case 'SELL': {
        checkCurrency(entry);
        const lots = lotsBySymbol.get(entry.symbol) ?? [];
        const held = lots.reduce((sum, lot) => sum.plus(lot.remainingQuantity), ZERO);
        // Specific sales get a per-lot explanation from specificSlices instead
        if (!entry.allocations && held.lt(entry.quantity)) {
          throw new LedgerViolationError(
            `Cannot sell ${fmt(entry.quantity)} ${entry.symbol} on ${entry.date}: only ${fmt(held)} held at that date`,
            { transactionId: entry.id, symbol: entry.symbol, requested: fmt(entry.quantity), held: fmt(held) },
          );
        }
        const slices = entry.allocations
          ? specificSlices(entry, lotsById, laterBuys)
          : fifoSlices(entry, lots);
        disposals.push(...consume(entry, slices, entry.allocations ? 'SPECIFIC' : 'FIFO'));
        lotsBySymbol.set(entry.symbol, lots.filter((lot) => lot.remainingQuantity.gt(0)));
        credit(entry.currency, entry.total);
        break;
      }
      case 'DIVIDEND': {
        credit(entry.currency, entry.netAmount);
        addDividend(dividends, entry.currency, entry);
        const key = `${entry.symbol}|${entry.currency}`;
        const bySymbol = dividendsBySymbol.get(key) ?? { symbol: entry.symbol, ...emptyDividendTotals(entry.currency) };
        dividendsBySymbol.set(key, { ...bySymbol, ...sumDividend(bySymbol, entry) });
        break;
      }
    }
  }

  const positions = new Map<string, Position>();
  for (const [symbol, lots] of lotsBySymbol) {
    if (lots.length === 0) continue;
    positions.set(symbol, {
      symbol,
      currency: lots[0].currency,
      quantity: lots.reduce((sum, lot) => sum.plus(lot.remainingQuantity), ZERO),
      costBase: lots.reduce((sum, lot) => sum.plus(lot.remainingCostBase), ZERO),
      lots,
    });
  }

  return { cash, positions, disposals, lotsById, dividends, dividendsBySymbol };
}

type Slice = { lot: Lot; quantity: MoneyDecimal };

/** FIFO: the oldest open lots first, in (acquiredOn, sequence) order */
function fifoSlices(entry: TradeEntry, lots: Lot[]): Slice[] {
  const slices: Slice[] = [];
  let toSell = entry.quantity;
  for (const lot of lots) {
    if (toSell.lte(0)) break;
    if (lot.remainingQuantity.lte(0)) continue;
    const quantity = MoneyDecimal.min(lot.remainingQuantity, toSell);
    slices.push({ lot, quantity });
    toSell = toSell.minus(quantity);
  }
  return slices;
}

/**
 * Specific identification: checks each allocation against the lots open at
 * this point of the replay. The lot must be a purchase of the same ticker in
 * this account (the replay only ever sees one account of one user, so a lot
 * of anyone else is simply unknown), acquired before the sale, with enough
 * shares left.
 */
function specificSlices(entry: TradeEntry, lotsById: Map<string, Lot>, laterBuys: Map<string, TradeEntry>): Slice[] {
  const allocations = entry.allocations!;
  const fail = (message: string, details: Record<string, unknown> = {}): never => {
    throw new LedgerViolationError(`Sale ${entry.id} of ${fmt(entry.quantity)} ${entry.symbol} on ${entry.date}: ${message}`, {
      transactionId: entry.id,
      symbol: entry.symbol,
      ...details,
    });
  };
  if (allocations.length === 0) fail('allocations must name at least one lot');
  const seen = new Set<string>();
  let allocated = ZERO;
  for (const allocation of allocations) {
    if (seen.has(allocation.lotId)) fail(`lot ${allocation.lotId} is allocated more than once`, { lotId: allocation.lotId });
    seen.add(allocation.lotId);
    if (allocation.quantity.lte(0)) fail(`the quantity allocated from lot ${allocation.lotId} must be greater than zero`, { lotId: allocation.lotId });
    allocated = allocated.plus(allocation.quantity);
  }
  if (!allocated.eq(entry.quantity)) {
    fail(`allocations add up to ${fmt(allocated)} shares, not the ${fmt(entry.quantity)} sold`, { allocated: fmt(allocated), quantity: fmt(entry.quantity) });
  }
  return allocations.map((allocation) => {
    const lot = lotsById.get(allocation.lotId);
    if (!lot) {
      const later = laterBuys.get(allocation.lotId);
      if (later && later.symbol === entry.symbol) {
        fail(`lot ${allocation.lotId} was bought on ${later.date}, after this sale, so it cannot be sold here`, { lotId: allocation.lotId, acquiredOn: later.date });
      }
      fail(`lot ${allocation.lotId} is not a purchase of ${entry.symbol} in this account`, { lotId: allocation.lotId });
    }
    if (lot!.symbol !== entry.symbol || lot!.currency !== entry.currency) {
      fail(`lot ${allocation.lotId} is a purchase of ${lot!.symbol} in ${lot!.currency}, not ${entry.symbol} in ${entry.currency}`, { lotId: allocation.lotId });
    }
    if (lot!.remainingQuantity.lt(allocation.quantity)) {
      fail(
        `lot ${allocation.lotId} (bought ${lot!.acquiredOn}) has only ${fmt(lot!.remainingQuantity)} shares left on that date, so ${fmt(allocation.quantity)} cannot be taken from it`,
        { lotId: allocation.lotId, requested: fmt(allocation.quantity), available: fmt(lot!.remainingQuantity) },
      );
    }
    return { lot: lot!, quantity: allocation.quantity };
  });
}

/**
 * Takes the slices out of their lots and works out each one's figures.
 *
 * Precision: cost base, net proceeds and fees are shared pro-rata by
 * quantity and rounded to the stored scale (10 dp, half-even). The last
 * slice of the sale takes what is left of the sale's total and fees, and a
 * slice that empties its lot takes the lot's whole remaining cost base, so
 * the parts always add up exactly to the totals.
 */
function consume(entry: TradeEntry, slices: Slice[], selection: LotSelection): Disposal[] {
  let proceedsLeft = entry.total;
  let feesLeft = entry.fees;
  return slices.map(({ lot, quantity }, index) => {
    const fullLot = quantity.eq(lot.remainingQuantity);
    const costBase = fullLot ? lot.remainingCostBase : toStored(lot.remainingCostBase.times(quantity).dividedBy(lot.remainingQuantity));
    const last = index === slices.length - 1;
    const proceeds = last ? proceedsLeft : toStored(entry.total.times(quantity).dividedBy(entry.quantity));
    const fees = last ? feesLeft : toStored(entry.fees.times(quantity).dividedBy(entry.quantity));

    lot.remainingQuantity = lot.remainingQuantity.minus(quantity);
    lot.remainingCostBase = fullLot ? ZERO : lot.remainingCostBase.minus(costBase);
    proceedsLeft = proceedsLeft.minus(proceeds);
    feesLeft = feesLeft.minus(fees);

    return {
      sellTransactionId: entry.id,
      lotId: lot.lotId,
      symbol: entry.symbol,
      currency: entry.currency,
      acquiredOn: lot.acquiredOn,
      disposedOn: entry.date,
      selection,
      quantity,
      costBase,
      fees,
      grossProceeds: proceeds.plus(fees),
      proceeds,
      gain: proceeds.minus(costBase),
      daysHeld: daysBetweenDates(lot.acquiredOn, entry.date),
      heldOverTwelveMonths: heldOverTwelveMonths(lot.acquiredOn, entry.date),
    };
  });
}

/** Calendar days from one YYYY-MM-DD date to another */
export function daysBetweenDates(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The ATO counts 12 months excluding the days of acquisition and disposal,
 * so a parcel bought on 2024-01-10 qualifies when sold on 2025-01-11 or later.
 * Dates are the calendar dates recorded on the transactions.
 */
export function heldOverTwelveMonths(acquiredOn: string, disposedOn: string): boolean {
  const [y, m, d] = acquiredOn.split('-').map(Number);
  const anniversaryMonthEnd = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  const anniversary = `${y + 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, anniversaryMonthEnd)).padStart(2, '0')}`;
  return disposedOn > anniversary;
}

function emptyDividendTotals(currency: string): DividendTotals {
  return { currency, grossAmount: ZERO, withholdingTax: ZERO, netAmount: ZERO, frankingCredits: ZERO };
}

function sumDividend(totals: DividendTotals, entry: DividendEntry): DividendTotals {
  return {
    currency: totals.currency,
    grossAmount: totals.grossAmount.plus(entry.grossAmount),
    withholdingTax: totals.withholdingTax.plus(entry.withholdingTax),
    netAmount: totals.netAmount.plus(entry.netAmount),
    frankingCredits: totals.frankingCredits.plus(entry.frankingCredits),
  };
}

function addDividend(map: Map<string, DividendTotals>, currency: string, entry: DividendEntry) {
  map.set(currency, sumDividend(map.get(currency) ?? emptyDividendTotals(currency), entry));
}

function describe(entry: LedgerEntry): string {
  switch (entry.type) {
    case 'BUY':
      return `buy of ${fmt(entry.quantity)} ${entry.symbol}`;
    case 'FX_CONVERSION':
      return `conversion from ${entry.fromCurrency} to ${entry.toCurrency}`;
    case 'TRANSFER_OUT':
      return 'transfer out';
    case 'TRANSFER_IN':
      return 'transfer in';
    default:
      return entry.type.toLowerCase().replace('_', ' ');
  }
}
