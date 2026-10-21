import { MoneyDecimal, ZERO, dec, fmt, fmtOrNull, parseDecimalOrNull } from '../common/decimal';
import { ValidationError } from '../common/errors';
import { isTransferLeg, type LedgerEntry, type TransactionType } from '../ledger/ledger.types';
import { resolveDividend, resolveFx, resolveTrade } from '../ledger/trade-math';
import type { TransactionEntity } from './transaction.entity';

/** Every user-suppliable field, as validated strings. null/undefined both mean "not given". */
export type TransactionFields = Partial<
  Record<
    | 'date' | 'description' | 'currency' | 'amount' | 'externalCurrency' | 'externalAmount'
    | 'fromCurrency' | 'toCurrency' | 'fromAmount' | 'toAmount' | 'rate'
    | 'symbol' | 'quantity' | 'unitPrice' | 'fees' | 'total'
    | 'grossAmount' | 'withholdingTax' | 'netAmount' | 'frankingCredits',
    string | null
  >
>;

/** The columns a transaction of a given type stores; everything else is null */
export type MaterializedColumns = Pick<
  TransactionEntity,
  | 'date' | 'description' | 'currency' | 'amount' | 'externalCurrency' | 'externalAmount' | 'symbol'
  | 'quantity' | 'unitPrice' | 'fees' | 'total' | 'fromCurrency' | 'fromAmount' | 'toCurrency' | 'toAmount'
  | 'fxRate' | 'grossAmount' | 'withholdingTax' | 'netAmount' | 'frankingCredits' | 'calculatedField'
>;

const blank: Omit<MaterializedColumns, 'date'> = {
  description: null, currency: null, amount: null, externalCurrency: null, externalAmount: null, symbol: null,
  quantity: null, unitPrice: null, fees: null, total: null, fromCurrency: null, fromAmount: null, toCurrency: null,
  toAmount: null, fxRate: null, grossAmount: null, withholdingTax: null, netAmount: null, frankingCredits: null,
  calculatedField: null,
};

const d = (value: string | null | undefined): MoneyDecimal | null => parseDecimalOrNull(value ?? null);

/**
 * Turns validated input into the stored columns of a transaction, working out
 * the calculated field (three-of-four trades, two-of-three dividends and FX).
 */
export function materialize(type: TransactionType, fields: TransactionFields): MaterializedColumns {
  if (isTransferLeg(type)) throw new ValidationError(`${type} transactions are recorded through a transfer, not on their own`);
  if (!fields.date) throw new ValidationError('date is required');
  const base = { ...blank, date: fields.date, description: fields.description ?? null };
  switch (type) {
    case 'DEPOSIT':
    case 'WITHDRAWAL': {
      const amount = required(fields, 'amount');
      if (amount.lte(0)) throw new ValidationError('amount must be greater than zero');
      const currency = requiredText(fields, 'currency');
      const hasExternal = Boolean(fields.externalCurrency) || Boolean(fields.externalAmount);
      if (hasExternal && !(fields.externalCurrency && fields.externalAmount)) {
        throw new ValidationError('externalCurrency and externalAmount go together');
      }
      if (fields.externalAmount && dec(fields.externalAmount).lte(0)) {
        throw new ValidationError('externalAmount must be greater than zero');
      }
      return {
        ...base,
        currency,
        amount: fmt(amount),
        externalCurrency: fields.externalCurrency ?? null,
        externalAmount: fields.externalAmount ? fmt(dec(fields.externalAmount)) : null,
      };
    }
    case 'FX_CONVERSION': {
      const fromCurrency = requiredText(fields, 'fromCurrency');
      const toCurrency = requiredText(fields, 'toCurrency');
      if (fromCurrency === toCurrency) throw new ValidationError('fromCurrency and toCurrency must differ');
      const fees = d(fields.fees) ?? ZERO;
      if (fees.lt(0)) throw new ValidationError('fees cannot be negative');
      const fx = resolveFx(toCurrency, fromCurrency, { fromAmount: d(fields.fromAmount), toAmount: d(fields.toAmount), rate: d(fields.rate) });
      return {
        ...base,
        fromCurrency,
        toCurrency,
        fromAmount: fmt(fx.fromAmount),
        toAmount: fmt(fx.toAmount),
        fxRate: fmt(fx.rate),
        fees: fmt(fees),
        calculatedField: fx.calculatedField,
      };
    }
    case 'BUY':
    case 'SELL': {
      const currency = requiredText(fields, 'currency');
      const trade = resolveTrade(type, currency, {
        quantity: d(fields.quantity),
        unitPrice: d(fields.unitPrice),
        fees: d(fields.fees),
        total: d(fields.total),
      });
      return {
        ...base,
        symbol: requiredText(fields, 'symbol'),
        currency,
        quantity: fmt(trade.quantity),
        unitPrice: fmt(trade.unitPrice),
        fees: fmt(trade.fees),
        total: fmt(trade.total),
        calculatedField: trade.calculatedField,
      };
    }
    case 'DIVIDEND': {
      const currency = requiredText(fields, 'currency');
      const dividend = resolveDividend(currency, {
        grossAmount: d(fields.grossAmount),
        withholdingTax: d(fields.withholdingTax),
        netAmount: d(fields.netAmount),
      });
      const franking = d(fields.frankingCredits) ?? ZERO;
      if (franking.lt(0)) throw new ValidationError('frankingCredits cannot be negative');
      return {
        ...base,
        symbol: requiredText(fields, 'symbol'),
        currency,
        grossAmount: fmt(dividend.grossAmount),
        withholdingTax: fmt(dividend.withholdingTax),
        netAmount: fmt(dividend.netAmount),
        frankingCredits: fmt(franking),
        calculatedField: dividend.calculatedField,
      };
    }
  }
}

/**
 * The fields a stored transaction was recorded with, minus the one Money
 * calculated, so an edit recalculates it from the new values.
 */
export function storedInputFields(entity: TransactionEntity): TransactionFields {
  const fields: TransactionFields = {
    date: entity.date,
    description: entity.description,
    currency: entity.currency,
    amount: entity.amount,
    externalCurrency: entity.externalCurrency,
    externalAmount: entity.externalAmount,
    fromCurrency: entity.fromCurrency,
    toCurrency: entity.toCurrency,
    fromAmount: entity.fromAmount,
    toAmount: entity.toAmount,
    rate: entity.fxRate,
    symbol: entity.symbol,
    quantity: entity.quantity,
    unitPrice: entity.unitPrice,
    fees: entity.fees,
    total: entity.total,
    grossAmount: entity.grossAmount,
    withholdingTax: entity.withholdingTax,
    netAmount: entity.netAmount,
    frankingCredits: entity.frankingCredits,
  };
  if (entity.calculatedField && entity.calculatedField in fields) {
    delete fields[entity.calculatedField as keyof TransactionFields];
  }
  return fields;
}

export function toLedgerEntry(t: TransactionEntity): LedgerEntry {
  const base = { id: t.id, date: t.date, sequence: t.sequence };
  switch (t.type) {
    case 'DEPOSIT':
    case 'WITHDRAWAL':
      return { ...base, type: t.type, currency: t.currency!, amount: dec(t.amount!) };
    case 'FX_CONVERSION':
      return {
        ...base,
        type: t.type,
        fromCurrency: t.fromCurrency!,
        fromAmount: dec(t.fromAmount!),
        toCurrency: t.toCurrency!,
        toAmount: dec(t.toAmount!),
        fees: dec(t.fees ?? '0'),
      };
    case 'BUY':
    case 'SELL':
      return {
        ...base,
        type: t.type,
        symbol: t.symbol!,
        currency: t.currency!,
        quantity: dec(t.quantity!),
        unitPrice: dec(t.unitPrice!),
        fees: dec(t.fees!),
        total: dec(t.total!),
      };
    case 'DIVIDEND':
      return {
        ...base,
        type: t.type,
        symbol: t.symbol!,
        currency: t.currency!,
        grossAmount: dec(t.grossAmount!),
        withholdingTax: dec(t.withholdingTax!),
        netAmount: dec(t.netAmount!),
        frankingCredits: dec(t.frankingCredits ?? '0'),
      };
    case 'TRANSFER_OUT':
    case 'TRANSFER_IN':
      return { ...base, type: t.type, currency: t.currency!, amount: dec(t.amount!), fees: dec(t.fees ?? '0') };
  }
}

export type TransactionView = {
  id: string;
  accountId: string;
  type: TransactionType;
  date: string;
  sequence: number;
  description: string | null;
  /** The field Money calculated from the others, if any */
  calculatedField: string | null;
  createdAt: string;
  updatedAt: string;
} & Record<string, unknown>;

/** API shape: decimals as canonical strings, only the fields that apply to the type */
export function toTransactionView(t: TransactionEntity): TransactionView {
  const view: TransactionView = {
    id: t.id,
    accountId: t.accountId,
    type: t.type,
    date: t.date,
    sequence: t.sequence,
    description: t.description,
    calculatedField: t.calculatedField,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
  const s = (value: string | null) => fmtOrNull(parseDecimalOrNull(value));
  switch (t.type) {
    case 'DEPOSIT':
    case 'WITHDRAWAL':
      Object.assign(view, {
        currency: t.currency,
        amount: s(t.amount),
        externalCurrency: t.externalCurrency,
        externalAmount: s(t.externalAmount),
      });
      break;
    case 'FX_CONVERSION':
      Object.assign(view, {
        fromCurrency: t.fromCurrency,
        fromAmount: s(t.fromAmount),
        toCurrency: t.toCurrency,
        toAmount: s(t.toAmount),
        rate: s(t.fxRate),
        fees: s(t.fees),
      });
      break;
    case 'BUY':
    case 'SELL':
      Object.assign(view, {
        symbol: t.symbol,
        currency: t.currency,
        quantity: s(t.quantity),
        unitPrice: s(t.unitPrice),
        fees: s(t.fees),
        total: s(t.total),
      });
      break;
    case 'DIVIDEND':
      Object.assign(view, {
        symbol: t.symbol,
        currency: t.currency,
        grossAmount: s(t.grossAmount),
        withholdingTax: s(t.withholdingTax),
        netAmount: s(t.netAmount),
        frankingCredits: s(t.frankingCredits),
      });
      break;
    case 'TRANSFER_OUT':
    case 'TRANSFER_IN':
      Object.assign(view, {
        currency: t.currency,
        amount: s(t.amount),
        ...(t.type === 'TRANSFER_OUT' ? { fees: s(t.fees) } : {}),
        transferId: t.transferId,
        counterpartyAccountId: t.counterpartyAccountId,
      });
      break;
  }
  return view;
}

function required(fields: TransactionFields, key: keyof TransactionFields): MoneyDecimal {
  const value = fields[key];
  if (value === null || value === undefined || value === '') throw new ValidationError(`${key} is required`);
  return dec(value);
}

function requiredText(fields: TransactionFields, key: keyof TransactionFields): string {
  const value = fields[key];
  if (!value) throw new ValidationError(`${key} is required`);
  return value;
}
