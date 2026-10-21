import { MoneyDecimal, ZERO, fmt } from '../common/decimal';
import { ValidationError } from '../common/errors';
import { resolveFx, type FxField } from '../ledger/trade-math';

export type TransferAmountsInput = {
  fromCurrency: string;
  toCurrency: string;
  fromAmount?: MoneyDecimal | null;
  toAmount?: MoneyDecimal | null;
  rate?: MoneyDecimal | null;
  fees?: MoneyDecimal | null;
};

export type ResolvedTransfer = {
  fromAmount: MoneyDecimal;
  toAmount: MoneyDecimal;
  rate: MoneyDecimal;
  fees: MoneyDecimal;
  calculatedField: FxField | null;
};

const ONE = new MoneyDecimal(1);

/**
 * Works out a transfer's amounts.
 *
 * Same currency: the amount arrives in full (toAmount = fromAmount, rate 1).
 * Give fromAmount or toAmount; both must match if both are given. Any cost is
 * recorded as fees, charged to the source on top of fromAmount.
 *
 * Different currencies: any two of fromAmount, toAmount and rate (toCurrency
 * per fromCurrency), exactly as for an FX conversion.
 */
export function resolveTransfer(input: TransferAmountsInput): ResolvedTransfer {
  const fees = input.fees ?? ZERO;
  if (fees.lt(0)) throw new ValidationError('fees cannot be negative');

  if (input.fromCurrency !== input.toCurrency) {
    const fx = resolveFx(input.toCurrency, input.fromCurrency, { fromAmount: input.fromAmount, toAmount: input.toAmount, rate: input.rate });
    return { ...fx, fees };
  }

  if (input.rate && !input.rate.eq(ONE)) {
    throw new ValidationError(`A transfer within ${input.fromCurrency} has rate 1; omit rate, or set toCurrency for a transfer between currencies`);
  }
  const { fromAmount, toAmount } = input;
  if (!fromAmount && !toAmount) throw new ValidationError('A transfer needs fromAmount (or toAmount)');
  if (fromAmount && toAmount && !fromAmount.eq(toAmount)) {
    throw new ValidationError(
      `In a transfer within ${input.fromCurrency}, toAmount (${fmt(toAmount)}) must equal fromAmount (${fmt(fromAmount)}). Record any cost as fees.`,
    );
  }
  const amount = (fromAmount ?? toAmount)!;
  if (amount.lte(0)) throw new ValidationError('amount must be greater than zero');
  return {
    fromAmount: amount,
    toAmount: amount,
    rate: ONE,
    fees,
    calculatedField: fromAmount && toAmount ? null : fromAmount ? 'toAmount' : 'fromAmount',
  };
}
