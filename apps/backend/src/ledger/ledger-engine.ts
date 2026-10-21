import { MoneyDecimal, ZERO, fmt } from '../common/decimal';
import { LedgerViolationError } from '../common/errors';
import type { DividendEntry, DividendTotals, Disposal, LedgerEntry, LedgerState, Lot, Position, TradeEntry } from './ledger.types';

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
 * Lot matching is FIFO: a sale consumes the oldest parcels first.
 */
export function replayLedger(entries: readonly LedgerEntry[]): LedgerState {
  const sorted = [...entries].sort(compareEntries);
  const cash = new Map<string, MoneyDecimal>();
  const lotsBySymbol = new Map<string, Lot[]>();
  const symbolCurrency = new Map<string, string>();
  const disposals: Disposal[] = [];
  const dividends = new Map<string, DividendTotals>();
  const dividendsBySymbol = new Map<string, DividendTotals & { symbol: string }>();

  const credit = (currency: string, amount: MoneyDecimal) => {
    cash.set(currency, (cash.get(currency) ?? ZERO).plus(amount));
  };
  const debit = (entry: LedgerEntry, currency: string, amount: MoneyDecimal) => {
    const balance = (cash.get(currency) ?? ZERO).minus(amount);
    if (balance.lt(0)) {
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
        lots.push({
          lotId: entry.id,
          symbol: entry.symbol,
          currency: entry.currency,
          acquiredOn: entry.date,
          originalQuantity: entry.quantity,
          originalCostBase: entry.total,
          remainingQuantity: entry.quantity,
          remainingCostBase: entry.total,
        });
        lotsBySymbol.set(entry.symbol, lots);
        break;
      }
      case 'SELL': {
        checkCurrency(entry);
        const lots = lotsBySymbol.get(entry.symbol) ?? [];
        const held = lots.reduce((sum, lot) => sum.plus(lot.remainingQuantity), ZERO);
        if (held.lt(entry.quantity)) {
          throw new LedgerViolationError(
            `Cannot sell ${fmt(entry.quantity)} ${entry.symbol} on ${entry.date}: only ${fmt(held)} held at that date`,
            { transactionId: entry.id, symbol: entry.symbol, requested: fmt(entry.quantity), held: fmt(held) },
          );
        }
        disposals.push(...consumeFifo(entry, lots));
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

  return { cash, positions, disposals, dividends, dividendsBySymbol };
}

/**
 * Matches a sale against lots, oldest first. Cost base is taken from each lot
 * in proportion to the quantity sold from it; the sale's net proceeds are
 * split in proportion to quantity. The last slice takes the remainder of
 * each, so the parts add up exactly to the totals.
 */
function consumeFifo(entry: TradeEntry, lots: Lot[]): Disposal[] {
  const result: Disposal[] = [];
  let toSell = entry.quantity;
  let proceedsLeft = entry.total;
  for (const lot of lots) {
    if (toSell.lte(0)) break;
    if (lot.remainingQuantity.lte(0)) continue;
    const taken = MoneyDecimal.min(lot.remainingQuantity, toSell);
    const fullLot = taken.eq(lot.remainingQuantity);
    const costBase = fullLot
      ? lot.remainingCostBase
      : lot.remainingCostBase.times(taken).dividedBy(lot.remainingQuantity);
    const lastSlice = taken.eq(toSell);
    const proceeds = lastSlice ? proceedsLeft : entry.total.times(taken).dividedBy(entry.quantity);

    lot.remainingQuantity = lot.remainingQuantity.minus(taken);
    lot.remainingCostBase = fullLot ? ZERO : lot.remainingCostBase.minus(costBase);
    toSell = toSell.minus(taken);
    proceedsLeft = proceedsLeft.minus(proceeds);

    result.push({
      sellTransactionId: entry.id,
      lotId: lot.lotId,
      symbol: entry.symbol,
      currency: entry.currency,
      acquiredOn: lot.acquiredOn,
      disposedOn: entry.date,
      quantity: taken,
      costBase,
      proceeds,
      gain: proceeds.minus(costBase),
      heldOverTwelveMonths: heldOverTwelveMonths(lot.acquiredOn, entry.date),
    });
  }
  return result;
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
