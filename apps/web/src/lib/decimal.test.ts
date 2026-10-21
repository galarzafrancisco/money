import { compareDecimals, formatDecimal, isPositiveDecimal, sumDecimals } from './decimal';

describe('decimal strings', () => {
  it('formats with grouping and money decimals, without floating point', () => {
    expect(formatDecimal('1234567.5', { minFraction: 2 })).toBe('1,234,567.50');
    expect(formatDecimal('0.1000000000')).toBe('0.1');
    expect(formatDecimal('-3000')).toBe('-3,000');
    expect(formatDecimal('12345678901234567890.123456789')).toBe('12,345,678,901,234,567,890.123456789');
    expect(formatDecimal('2.005', { maxFraction: 2 })).toBe('2.01');
    expect(formatDecimal('-0.001', { maxFraction: 2 })).toBe('0');
  });

  it('adds exactly where floats would not', () => {
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimals(['15', '25', ''])).toBe('40');
    expect(sumDecimals(['0.0000000001', '0.0000000002'])).toBe('0.0000000003');
  });

  it('compares and validates', () => {
    expect(compareDecimals('40', '40.000')).toBe(0);
    expect(compareDecimals('100.5', '100.49')).toBe(1);
    expect(isPositiveDecimal('0')).toBe(false);
    expect(isPositiveDecimal('0.01')).toBe(true);
    expect(isPositiveDecimal('1,000')).toBe(false);
  });
});
