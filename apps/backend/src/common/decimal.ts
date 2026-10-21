import Decimal from 'decimal.js';

/**
 * All money, FX and share quantities are handled as decimal.js values in the
 * app, stored as Postgres `numeric`, and exchanged as decimal strings over
 * REST and MCP. JavaScript numbers are never used for amounts.
 */
export const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export type MoneyDecimal = InstanceType<typeof MoneyDecimal>;

/** Digits after the point that are stored for any amount, quantity, price or rate */
export const STORED_SCALE = 10;

/** Tolerance when quantity × price + fees is checked against a supplied total */
export const TRADE_TOTAL_TOLERANCE = new MoneyDecimal('0.01');

export const ZERO = new MoneyDecimal(0);

export function dec(value: MoneyDecimal | string | number): MoneyDecimal {
  return new MoneyDecimal(value);
}

/** Rounds to the stored scale, so the value fits a numeric(…,10) column */
export function toStored(value: MoneyDecimal): MoneyDecimal {
  return value.toDecimalPlaces(STORED_SCALE, MoneyDecimal.ROUND_HALF_EVEN);
}

/** Canonical decimal string: no exponent, no trailing zeros */
export function fmt(value: MoneyDecimal): string {
  const fixed = toStored(value).toFixed();
  return fixed === '-0' ? '0' : fixed;
}

export function fmtOrNull(value: MoneyDecimal | null | undefined): string | null {
  return value === null || value === undefined ? null : fmt(value);
}

export function parseDecimalOrNull(value: string | null | undefined): MoneyDecimal | null {
  return value === null || value === undefined ? null : new MoneyDecimal(value);
}

/** Matches a plain decimal string: optional sign, digits, optional fraction */
export const DECIMAL_PATTERN = /^-?(?:\d+)(?:\.\d+)?$/;
