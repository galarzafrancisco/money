import { MoneyDecimal } from '../common/decimal';

/**
 * ISO 4217 minor units for currencies without the usual 2. Used only to round
 * amounts Money calculates (a trade total, implied fees, an FX leg). Amounts the
 * user supplies are kept as given.
 */
const MINOR_UNITS: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 2, BHD: 3, KWD: 3, OMR: 3, TND: 3, JOD: 3,
};

export function minorUnits(currency: string): number {
  return MINOR_UNITS[currency] ?? 2;
}

export function roundMoney(value: MoneyDecimal, currency: string): MoneyDecimal {
  return value.toDecimalPlaces(minorUnits(currency), MoneyDecimal.ROUND_HALF_UP);
}
