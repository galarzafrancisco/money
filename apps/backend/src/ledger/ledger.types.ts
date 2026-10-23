import type { MoneyDecimal } from '../common/decimal';

export const TRANSACTION_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'GAIN_LOSS', 'FX_CONVERSION', 'BUY', 'SELL', 'DIVIDEND', 'TRANSFER_OUT', 'TRANSFER_IN'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
/** The legs of a transfer between two accounts. They are created, edited and deleted only through the transfer. */
export const TRANSFER_LEG_TYPES = ['TRANSFER_OUT', 'TRANSFER_IN'] as const;
export type TransferLegType = (typeof TRANSFER_LEG_TYPES)[number];
/** Types that can be recorded directly on one account */
export type RecordableTransactionType = Exclude<TransactionType, TransferLegType>;
export function isTransferLeg(type: string): type is TransferLegType {
  return (TRANSFER_LEG_TYPES as readonly string[]).includes(type);
}

type Base = {
  id: string;
  /** Economic date (YYYY-MM-DD) */
  date: string;
  /** Insertion order, the tie-break between entries on the same date */
  sequence: number;
};

export type CashEntry = Base & { type: 'DEPOSIT' | 'WITHDRAWAL'; currency: string; amount: MoneyDecimal };
/**
 * Value change that is not a cash flow in or out of the account, e.g. the
 * appreciation of a superannuation balance or a fund's unit price moving.
 * `amount` is signed: positive is a gain, negative a loss.
 */
export type GainLossEntry = Base & { type: 'GAIN_LOSS'; currency: string; amount: MoneyDecimal };
export type FxEntry = Base & {
        type: 'FX_CONVERSION';
        fromCurrency: string;
        fromAmount: MoneyDecimal;
        toCurrency: string;
        toAmount: MoneyDecimal;
        /** Charged in fromCurrency, on top of fromAmount */
        fees: MoneyDecimal;
      };
export type TradeEntry = Base & {
        type: 'BUY' | 'SELL';
        symbol: string;
        currency: string;
        quantity: MoneyDecimal;
        unitPrice: MoneyDecimal;
        fees: MoneyDecimal;
        /** BUY: cash paid incl. fees. SELL: cash received net of fees. */
        total: MoneyDecimal;
        /**
         * SELL only. When present the sale uses specific identification: it
         * consumes exactly these quantities from these lots, in this order.
         * Absent means FIFO.
         */
        allocations?: readonly LotAllocation[];
      };

/** Lot-matching method of a sale */
export const LOT_SELECTIONS = ['FIFO', 'SPECIFIC'] as const;
export type LotSelection = (typeof LOT_SELECTIONS)[number];

/** Part of a sale explicitly taken from one purchase lot */
export type LotAllocation = { lotId: string; quantity: MoneyDecimal };
export type DividendEntry = Base & {
        type: 'DIVIDEND';
        symbol: string;
        currency: string;
        grossAmount: MoneyDecimal;
        withholdingTax: MoneyDecimal;
        netAmount: MoneyDecimal;
        frankingCredits: MoneyDecimal;
      };

/** One side of a transfer between two of the user's accounts */
export type TransferEntry = Base & {
        type: TransferLegType;
        currency: string;
        /** TRANSFER_OUT: amount leaving (excluding fees). TRANSFER_IN: amount arriving. */
        amount: MoneyDecimal;
        /** TRANSFER_OUT only: fees charged in `currency` on top of amount; zero on TRANSFER_IN */
        fees: MoneyDecimal;
      };

export type LedgerEntry = CashEntry | GainLossEntry | FxEntry | TradeEntry | DividendEntry | TransferEntry;

/** A parcel of shares bought by one BUY, as far as it has not been sold. Its ID is the BUY transaction's ID. */
export type Lot = {
  lotId: string;
  /** The BUY's sequence: with acquiredOn, the lot's position in FIFO order */
  sequence: number;
  symbol: string;
  currency: string;
  acquiredOn: string;
  originalQuantity: MoneyDecimal;
  /** Total cost base of the parcel when bought: price × quantity + brokerage */
  originalCostBase: MoneyDecimal;
  remainingQuantity: MoneyDecimal;
  remainingCostBase: MoneyDecimal;
};

/** The part of one SELL matched against one lot */
export type Disposal = {
  sellTransactionId: string;
  lotId: string;
  symbol: string;
  currency: string;
  acquiredOn: string;
  disposedOn: string;
  /** How the sale picked this lot */
  selection: LotSelection;
  quantity: MoneyDecimal;
  costBase: MoneyDecimal;
  /** Share of the sale's brokerage and fees, pro-rata by quantity */
  fees: MoneyDecimal;
  /** Share of the sale's proceeds before fees: proceeds + fees */
  grossProceeds: MoneyDecimal;
  /** Share of the sale's net proceeds (after brokerage): grossProceeds − fees */
  proceeds: MoneyDecimal;
  gain: MoneyDecimal;
  /** Calendar days from acquisition to disposal */
  daysHeld: number;
  /**
   * Disposed of more than 12 months after acquisition, the ATO's test for the
   * CGT discount. Informational only: no discount is applied.
   */
  heldOverTwelveMonths: boolean;
};

export type Position = {
  symbol: string;
  currency: string;
  quantity: MoneyDecimal;
  costBase: MoneyDecimal;
  lots: Lot[];
};

export type DividendTotals = {
  currency: string;
  grossAmount: MoneyDecimal;
  withholdingTax: MoneyDecimal;
  netAmount: MoneyDecimal;
  frankingCredits: MoneyDecimal;
};

export type LedgerState = {
  /** Cash per currency; currencies that were ever used stay listed */
  cash: Map<string, MoneyDecimal>;
  /** Open positions only (quantity > 0) */
  positions: Map<string, Position>;
  disposals: Disposal[];
  /** Every lot ever opened, including fully sold ones, by lot ID */
  lotsById: Map<string, Lot>;
  dividends: Map<string, DividendTotals>;
  /** Dividends per symbol and currency */
  dividendsBySymbol: Map<string, DividendTotals & { symbol: string }>;
};
