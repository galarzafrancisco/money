/**
 * Exact handling of decimal strings for display and input checks. Amounts
 * stay strings end to end (docs/ui/guidelines.md §6.5): nothing here turns
 * them into JavaScript numbers. The backend owns all accounting maths; the UI
 * only formats values and, for lot selection, checks that typed quantities
 * add up to the sale quantity, using scaled BigInts so the check is exact.
 */
const DECIMAL = /^-?\d+(\.\d+)?$/;
const SCALE = 10;

export function isDecimal(value: string): boolean {
  return DECIMAL.test(value.trim());
}

/** A positive decimal (greater than zero) */
export function isPositiveDecimal(value: string): boolean {
  const v = value.trim();
  return isDecimal(v) && !v.startsWith('-') && /[1-9]/.test(v);
}

function toScaled(value: string): bigint {
  const v = value.trim();
  if (!isDecimal(v)) throw new Error(`Not a decimal: ${value}`);
  const negative = v.startsWith('-');
  const [whole, fraction = ''] = (negative ? v.slice(1) : v).split('.');
  if (fraction.length > SCALE) throw new Error(`More than ${SCALE} decimal places: ${value}`);
  const scaled = BigInt(whole + fraction.padEnd(SCALE, '0'));
  return negative ? -scaled : scaled;
}

function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(SCALE + 1, '0');
  const whole = digits.slice(0, -SCALE);
  const fraction = digits.slice(-SCALE).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Exact sum of decimal strings (blank entries count as zero) */
export function sumDecimals(values: readonly string[]): string {
  return fromScaled(values.filter((v) => v.trim() !== '').reduce((total, v) => total + toScaled(v), 0n));
}

/** -1, 0 or 1 */
export function compareDecimals(a: string, b: string): number {
  const x = toScaled(a);
  const y = toScaled(b);
  return x === y ? 0 : x < y ? -1 : 1;
}

export function decimalSign(value: string): -1 | 0 | 1 {
  return compareDecimals(value, '0') as -1 | 0 | 1;
}

/**
 * Groups thousands and trims trailing zeros, keeping at least `minFraction`
 * decimals (2 for money). All significant digits are kept unless
 * `maxFraction` is given, which rounds half-up on the scaled integer.
 */
export function formatDecimal(value: string, options: { minFraction?: number; maxFraction?: number } = {}): string {
  const v = value.trim();
  if (!isDecimal(v)) return value;
  const { minFraction = 0, maxFraction } = options;
  let normalized = v;
  if (maxFraction !== undefined) normalized = roundString(v, maxFraction);
  const negative = normalized.startsWith('-');
  const [whole, rawFraction = ''] = (negative ? normalized.slice(1) : normalized).split('.');
  let fraction = rawFraction.replace(/0+$/, '');
  if (fraction.length < minFraction) fraction = fraction.padEnd(minFraction, '0');
  const grouped = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const isZero = !/[1-9]/.test(whole + fraction);
  return `${negative && !isZero ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/** Half-up rounding of a decimal string to `places` decimals, done on the scaled integer */
function roundString(value: string, places: number): string {
  if (places >= SCALE) return value;
  const scaled = toScaled(value);
  const factor = 10n ** BigInt(SCALE - places);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const rounded = ((abs + factor / 2n) / factor) * factor;
  return fromScaled(negative ? -rounded : rounded);
}

/**
 * Compact display for large amounts, exact on the scaled integer:
 * below 10,000 the full value with 2 decimals; from 10,000 up, thousands
 * with no decimals (125,241.62 → 125K); from 1,000,000 up, millions with up
 * to 2 decimals (1.23M); from 10,000,000 up, millions with no decimals.
 */
export function formatCompactDecimal(value: string): string {
  const v = value.trim();
  if (!isDecimal(v)) return value;
  const scaled = toScaled(v);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const unit = 10n ** BigInt(SCALE);
  const whole = abs / unit;
  const sign = negative ? '-' : '';
  const divide = (divisor: bigint, places: number, suffix: string) => {
    const text = fromScaled(abs / divisor);
    return `${sign}${formatDecimal(text, { maxFraction: places })}${suffix}`;
  };
  if (whole >= 10_000_000n) return `${sign}${formatDecimal(roundString(fromScaled(abs / 1_000_000n), 0))}M`;
  if (whole >= 1_000_000n) return divide(1_000_000n, 2, 'M');
  if (whole >= 10_000n) return `${sign}${formatDecimal(roundString(fromScaled(abs / 1_000n), 0))}K`;
  return formatDecimal(value, { minFraction: 2, maxFraction: 2 });
}
