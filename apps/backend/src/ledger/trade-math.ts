import { MoneyDecimal, STORED_SCALE, TRADE_TOTAL_TOLERANCE, ZERO, fmt } from '../common/decimal';
import { ValidationError } from '../common/errors';
import { roundMoney } from './currency';

export type TradeSide = 'BUY' | 'SELL';
export type TradeField = 'quantity' | 'unitPrice' | 'fees' | 'total';
export const TRADE_FIELDS: readonly TradeField[] = ['quantity', 'unitPrice', 'fees', 'total'];

export type TradeInput = Partial<Record<TradeField, MoneyDecimal | null>>;

export type ResolvedTrade = Record<TradeField, MoneyDecimal> & {
  /** The field Money calculated, or null when all four were supplied */
  calculatedField: TradeField | null;
};

/**
 * Resolves a share trade from any three of quantity, unit price, fees and
 * total, and checks the four agree when all are given.
 *
 *   BUY:  total = quantity × unitPrice + fees   (cash paid)
 *   SELL: total = quantity × unitPrice − fees   (net cash received)
 *
 * A calculated quantity or unit price keeps 10 decimal places; a calculated
 * total or fee is rounded to the currency's minor unit (cents). When all four
 * are supplied they are stored as given, provided quantity × unitPrice ± fees
 * is within 0.01 of the total (brokers round prices and totals).
 */
export function resolveTrade(side: TradeSide, currency: string, input: TradeInput): ResolvedTrade {
  const given = TRADE_FIELDS.filter((field) => input[field] !== undefined && input[field] !== null);
  if (given.length < 3) {
    const missing = TRADE_FIELDS.filter((field) => !given.includes(field));
    throw new ValidationError(
      `A ${side.toLowerCase()} needs at least three of quantity, unitPrice, fees and total; missing ${missing.join(' and ')}`,
      { missing },
    );
  }
  const { quantity, unitPrice, fees, total } = input as Record<TradeField, MoneyDecimal | undefined>;

  if (quantity && quantity.lte(0)) throw invalid('quantity must be greater than zero');
  if (unitPrice && unitPrice.lt(0)) throw invalid('unitPrice cannot be negative');
  if (fees && fees.lt(0)) throw invalid('fees cannot be negative');
  if (total && total.lt(0)) throw invalid('total cannot be negative');

  // Gross value of the shares (quantity × unitPrice), derived from total and fees
  const grossFromTotal = (t: MoneyDecimal, f: MoneyDecimal) => (side === 'BUY' ? t.minus(f) : t.plus(f));
  const totalFromGross = (g: MoneyDecimal, f: MoneyDecimal) => (side === 'BUY' ? g.plus(f) : g.minus(f));

  if (given.length === 4) {
    const expected = totalFromGross(quantity!.times(unitPrice!), fees!);
    if (expected.minus(total!).abs().gt(TRADE_TOTAL_TOLERANCE)) {
      throw invalid(
        `quantity × unitPrice ${side === 'BUY' ? '+' : '−'} fees is ${fmt(expected)}, which does not match total ${fmt(total!)} (tolerance ${fmt(TRADE_TOTAL_TOLERANCE)})`,
      );
    }
    return { quantity: quantity!, unitPrice: unitPrice!, fees: fees!, total: total!, calculatedField: null };
  }

  const missing = TRADE_FIELDS.find((field) => !given.includes(field))!;
  switch (missing) {
    case 'total': {
      const computed = roundMoney(totalFromGross(quantity!.times(unitPrice!), fees!), currency);
      if (computed.lt(0)) throw invalid('fees are larger than the sale value, so the total would be negative');
      return { quantity: quantity!, unitPrice: unitPrice!, fees: fees!, total: computed, calculatedField: 'total' };
    }
    case 'fees': {
      const gross = quantity!.times(unitPrice!);
      const computed = roundMoney(side === 'BUY' ? total!.minus(gross) : gross.minus(total!), currency);
      if (computed.lt(0)) {
        throw invalid(
          `total ${fmt(total!)} implies negative fees (${fmt(computed)}): for a ${side.toLowerCase()} the total must be ${side === 'BUY' ? 'at least' : 'at most'} quantity × unitPrice (${fmt(gross)})`,
        );
      }
      return { quantity: quantity!, unitPrice: unitPrice!, fees: computed, total: total!, calculatedField: 'fees' };
    }
    case 'quantity': {
      const gross = grossFromTotal(total!, fees!);
      if (gross.lte(0)) throw invalid('total and fees leave nothing for the shares, so quantity cannot be calculated');
      if (unitPrice!.isZero()) throw invalid('unitPrice is zero, so quantity cannot be calculated; supply quantity');
      const computed = gross.dividedBy(unitPrice!).toDecimalPlaces(STORED_SCALE, MoneyDecimal.ROUND_HALF_EVEN);
      if (computed.lte(0)) throw invalid('calculated quantity rounds to zero');
      return { quantity: computed, unitPrice: unitPrice!, fees: fees!, total: total!, calculatedField: 'quantity' };
    }
    case 'unitPrice': {
      const gross = grossFromTotal(total!, fees!);
      if (gross.lt(0)) throw invalid('total and fees imply a negative unit price');
      const computed = gross.dividedBy(quantity!).toDecimalPlaces(STORED_SCALE, MoneyDecimal.ROUND_HALF_EVEN);
      return { quantity: quantity!, unitPrice: computed, fees: fees!, total: total!, calculatedField: 'unitPrice' };
    }
  }
}

export type DividendField = 'grossAmount' | 'withholdingTax' | 'netAmount';
export const DIVIDEND_FIELDS: readonly DividendField[] = ['grossAmount', 'withholdingTax', 'netAmount'];
export type ResolvedDividend = Record<DividendField, MoneyDecimal> & { calculatedField: DividendField | null };

/**
 * Resolves a dividend from any two of gross amount, withholding tax and net
 * amount (net = gross − withholding). Pass withholdingTax "0" when none was
 * withheld. When all three are given they must agree within 0.01.
 */
export function resolveDividend(
  currency: string,
  input: Partial<Record<DividendField, MoneyDecimal | null>>,
): ResolvedDividend {
  const given = DIVIDEND_FIELDS.filter((field) => input[field] !== undefined && input[field] !== null);
  if (given.length < 2) {
    throw new ValidationError(
      'A dividend needs at least two of grossAmount, withholdingTax and netAmount (use withholdingTax "0" when nothing was withheld)',
      { missing: DIVIDEND_FIELDS.filter((field) => !given.includes(field)) },
    );
  }
  let { grossAmount, withholdingTax, netAmount } = input as Record<DividendField, MoneyDecimal | undefined>;
  let calculatedField: DividendField | null = null;
  if (!grossAmount) {
    grossAmount = roundMoney(netAmount!.plus(withholdingTax!), currency);
    calculatedField = 'grossAmount';
  } else if (!withholdingTax) {
    withholdingTax = roundMoney(grossAmount.minus(netAmount!), currency);
    calculatedField = 'withholdingTax';
  } else if (!netAmount) {
    netAmount = roundMoney(grossAmount.minus(withholdingTax), currency);
    calculatedField = 'netAmount';
  } else if (grossAmount.minus(withholdingTax).minus(netAmount).abs().gt(TRADE_TOTAL_TOLERANCE)) {
    throw invalid(`grossAmount − withholdingTax (${fmt(grossAmount.minus(withholdingTax))}) does not match netAmount ${fmt(netAmount)}`);
  }
  if (!withholdingTax || !netAmount) throw new Error('unreachable');
  if (grossAmount.lte(0)) throw invalid('grossAmount must be greater than zero');
  if (withholdingTax.lt(0)) throw invalid('withholdingTax cannot be negative');
  if (netAmount.lt(0)) throw invalid('withholdingTax cannot be larger than grossAmount');
  return { grossAmount, withholdingTax, netAmount, calculatedField };
}

export type FxField = 'fromAmount' | 'toAmount' | 'rate';
export type ResolvedFx = { fromAmount: MoneyDecimal; toAmount: MoneyDecimal; rate: MoneyDecimal; calculatedField: FxField | null };

/**
 * Resolves an FX conversion from any two of the amount sold, the amount
 * bought and the rate (units of the bought currency per unit sold). With all
 * three, the rate must agree with the amounts to within 0.01 of toAmount.
 */
export function resolveFx(
  toCurrency: string,
  fromCurrency: string,
  input: Partial<Record<FxField, MoneyDecimal | null>>,
): ResolvedFx {
  let { fromAmount, toAmount, rate } = input as Record<FxField, MoneyDecimal | null | undefined>;
  const count = [fromAmount, toAmount, rate].filter((v) => v !== undefined && v !== null).length;
  if (count < 2) {
    throw new ValidationError('An FX conversion needs at least two of fromAmount, toAmount and rate');
  }
  if (fromAmount && fromAmount.lte(0)) throw invalid('fromAmount must be greater than zero');
  if (toAmount && toAmount.lte(0)) throw invalid('toAmount must be greater than zero');
  if (rate && rate.lte(0)) throw invalid('rate must be greater than zero');
  let calculatedField: FxField | null = null;
  if (!fromAmount) {
    fromAmount = roundMoney(toAmount!.dividedBy(rate!), fromCurrency);
    calculatedField = 'fromAmount';
  } else if (!toAmount) {
    toAmount = roundMoney(fromAmount.times(rate!), toCurrency);
    calculatedField = 'toAmount';
  } else if (!rate) {
    rate = toAmount.dividedBy(fromAmount).toDecimalPlaces(STORED_SCALE, MoneyDecimal.ROUND_HALF_EVEN);
    calculatedField = 'rate';
  } else if (fromAmount.times(rate).minus(toAmount).abs().gt(TRADE_TOTAL_TOLERANCE)) {
    throw invalid(`fromAmount × rate (${fmt(fromAmount.times(rate))}) does not match toAmount ${fmt(toAmount)}`);
  }
  if (!toAmount || !rate) throw new Error('unreachable');
  if (fromAmount.lte(ZERO) || toAmount.lte(ZERO)) throw invalid('calculated amount rounds to zero');
  return { fromAmount, toAmount, rate, calculatedField };
}

function invalid(message: string): ValidationError {
  return new ValidationError(message);
}
