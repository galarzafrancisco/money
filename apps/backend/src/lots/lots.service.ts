import { Injectable } from '@nestjs/common';
import { MoneyDecimal, ZERO, fmt } from '../common/decimal';
import { NotFoundError, ValidationError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { AccountsRepository } from '../accounts/accounts.repository';
import { daysBetweenDates, heldOverTwelveMonths, replayLedger } from '../ledger/ledger-engine';
import type { Disposal, LotSelection } from '../ledger/ledger.types';
import { toLedgerEntry } from '../transactions/transaction.mapper';
import { TransactionsRepository } from '../transactions/transactions.repository';
import type { CurrentUser } from '../users/users.service';
import { listLotsSchema, type ListLotsInput } from './lots.schemas';

/** Returned with lot and allocation figures so no client presents them as tax advice */
export const LOT_NOTES = [
  'Personal tracking only, not tax advice. Check figures with the ATO or a registered tax agent.',
  'A lot is one purchase (BUY); its lotId is that transaction\'s ID. Several purchases on one date are separate lots.',
  'Sales with allocations use specific identification: they take exactly the shares named. Sales without allocations take the oldest open lots first (FIFO), so their matches can move when earlier history is edited.',
  'Cost base includes brokerage. A sale\'s fees and net proceeds are shared between its lots pro-rata by quantity, rounded to 10 decimal places; the last allocation takes the remainder, so parts add up exactly to the sale.',
  'Figures are in the trade currency, not converted to AUD. heldOverTwelveMonths flags the 12-month test for the CGT discount; no discount is applied.',
];

export type LotView = {
  lotId: string;
  /** Same as lotId: the BUY this lot came from */
  buyTransactionId: string;
  accountId: string;
  symbol: string;
  currency: string;
  acquiredOn: string;
  /** With acquiredOn, the lot's FIFO position (order recorded on the same date) */
  sequence: number;
  status: 'OPEN' | 'CLOSED';
  originalQuantity: string;
  originalCostBase: string;
  unitCostBase: string;
  remainingQuantity: string;
  remainingCostBase: string;
  /** Days from acquisition to asOf (or today) */
  daysHeld: number;
  /** Whether a sale on asOf (or today) would pass the 12-month test */
  heldOverTwelveMonths: boolean;
  /** Sales that took shares from this lot, up to asOf */
  disposals: { saleTransactionId: string; disposedOn: string; selection: LotSelection; quantity: string; costBase: string }[];
};

export type LotsView = {
  accountId: string;
  asOf: string | null;
  symbol: string | null;
  excludedTransactionId: string | null;
  lots: LotView[];
  notes: string[];
};

export type AllocationView = {
  lotId: string;
  acquiredOn: string;
  quantity: string;
  unitCostBase: string;
  costBase: string;
  grossProceeds: string;
  fees: string;
  proceeds: string;
  gain: string;
  daysHeld: number;
  heldOverTwelveMonths: boolean;
};

export type SaleAllocationsView = {
  saleTransactionId: string;
  accountId: string;
  symbol: string;
  currency: string;
  date: string;
  lotSelection: LotSelection;
  quantity: string;
  unitPrice: string;
  fees: string;
  total: string;
  allocations: AllocationView[];
  totals: { quantity: string; costBase: string; grossProceeds: string; fees: string; proceeds: string; gain: string };
  notes: string[];
};

/**
 * Read-only views of purchase lots and of how sales consumed them. Both
 * come from replaying the account's ledger (with stored allocations), so
 * they always agree with the portfolio, reports and valuations.
 */
@Injectable()
export class LotsService {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly accounts: AccountsRepository,
  ) {}

  /**
   * The account's lots as they stood at the end of asOf. A sale recorded
   * on asOf comes after everything already recorded that day, so these are
   * the shares it may allocate from. A write still replays the whole
   * history: a backdated sale is refused if a later sale then no longer fits.
   */
  async listLots(user: CurrentUser, accountId: string, input: ListLotsInput = {}): Promise<LotsView> {
    const query = parseInput(listLotsSchema, input);
    const account = isUuid(accountId) ? await this.accounts.find(user.id, accountId) : null;
    if (!account) throw new NotFoundError(`Account ${accountId} not found`);
    let rows = await this.transactions.listForAccount(user.id, account.id);
    if (query.excludeTransactionId !== undefined) {
      const excluded = rows.find((row) => row.id === query.excludeTransactionId?.toLowerCase());
      if (!excluded) throw new NotFoundError(`Transaction ${query.excludeTransactionId} not found in this account`);
      if (excluded.type !== 'SELL') throw new ValidationError('excludeTransactionId must be a SELL');
      rows = rows.filter((row) => row.id !== excluded.id);
    }
    if (query.asOf) rows = rows.filter((row) => row.date <= query.asOf!);
    // Leaving a sale out can remove the cash later purchases relied on; that doesn't change lots
    const state = replayLedger(rows.map(toLedgerEntry), { ignoreCash: query.excludeTransactionId !== undefined });
    const onDate = query.asOf ?? new Date().toISOString().slice(0, 10);

    const disposalsByLot = new Map<string, Disposal[]>();
    for (const disposal of state.disposals) disposalsByLot.set(disposal.lotId, [...(disposalsByLot.get(disposal.lotId) ?? []), disposal]);

    const lots = [...state.lotsById.values()]
      .filter((lot) => (query.symbol ? lot.symbol === query.symbol : true))
      .filter((lot) => query.includeClosed || lot.remainingQuantity.gt(0))
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || (a.acquiredOn < b.acquiredOn ? -1 : a.acquiredOn > b.acquiredOn ? 1 : a.sequence - b.sequence))
      .map((lot): LotView => ({
        lotId: lot.lotId,
        buyTransactionId: lot.lotId,
        accountId: account.id,
        symbol: lot.symbol,
        currency: lot.currency,
        acquiredOn: lot.acquiredOn,
        sequence: lot.sequence,
        status: lot.remainingQuantity.gt(0) ? 'OPEN' : 'CLOSED',
        originalQuantity: fmt(lot.originalQuantity),
        originalCostBase: fmt(lot.originalCostBase),
        unitCostBase: fmt(lot.originalCostBase.dividedBy(lot.originalQuantity)),
        remainingQuantity: fmt(lot.remainingQuantity),
        remainingCostBase: fmt(lot.remainingCostBase),
        daysHeld: daysBetweenDates(lot.acquiredOn, onDate),
        heldOverTwelveMonths: heldOverTwelveMonths(lot.acquiredOn, onDate),
        disposals: (disposalsByLot.get(lot.lotId) ?? []).map((d) => ({
          saleTransactionId: d.sellTransactionId,
          disposedOn: d.disposedOn,
          selection: d.selection,
          quantity: fmt(d.quantity),
          costBase: fmt(d.costBase),
        })),
      }));

    return {
      accountId: account.id,
      asOf: query.asOf ?? null,
      symbol: query.symbol ?? null,
      excludedTransactionId: query.excludeTransactionId?.toLowerCase() ?? null,
      lots,
      notes: LOT_NOTES,
    };
  }

  /** One sale, split by the lots it consumed, with per-lot cost base, proceeds, fees, gain and holding period */
  async saleAllocations(user: CurrentUser, transactionId: string): Promise<SaleAllocationsView> {
    const sale = isUuid(transactionId) ? await this.transactions.find(user.id, transactionId) : null;
    if (!sale) throw new NotFoundError(`Transaction ${transactionId} not found`);
    if (sale.type !== 'SELL') throw new ValidationError(`Transaction ${transactionId} is a ${sale.type}, not a SELL`);
    const rows = await this.transactions.listForAccount(user.id, sale.accountId);
    const state = replayLedger(rows.map(toLedgerEntry));
    const disposals = state.disposals.filter((d) => d.sellTransactionId === sale.id);

    const sum = (pick: (d: Disposal) => MoneyDecimal) => fmt(disposals.reduce((total, d) => total.plus(pick(d)), ZERO));
    return {
      saleTransactionId: sale.id,
      accountId: sale.accountId,
      symbol: sale.symbol!,
      currency: sale.currency!,
      date: sale.date,
      lotSelection: sale.lotSelection ?? 'FIFO',
      quantity: fmt(new MoneyDecimal(sale.quantity!)),
      unitPrice: fmt(new MoneyDecimal(sale.unitPrice!)),
      fees: fmt(new MoneyDecimal(sale.fees!)),
      total: fmt(new MoneyDecimal(sale.total!)),
      allocations: disposals.map((d) => {
        const lot = state.lotsById.get(d.lotId)!;
        return {
          lotId: d.lotId,
          acquiredOn: d.acquiredOn,
          quantity: fmt(d.quantity),
          unitCostBase: fmt(lot.originalCostBase.dividedBy(lot.originalQuantity)),
          costBase: fmt(d.costBase),
          grossProceeds: fmt(d.grossProceeds),
          fees: fmt(d.fees),
          proceeds: fmt(d.proceeds),
          gain: fmt(d.gain),
          daysHeld: d.daysHeld,
          heldOverTwelveMonths: d.heldOverTwelveMonths,
        };
      }),
      totals: {
        quantity: sum((d) => d.quantity),
        costBase: sum((d) => d.costBase),
        grossProceeds: sum((d) => d.grossProceeds),
        fees: sum((d) => d.fees),
        proceeds: sum((d) => d.proceeds),
        gain: sum((d) => d.gain),
      },
      notes: LOT_NOTES,
    };
  }
}
