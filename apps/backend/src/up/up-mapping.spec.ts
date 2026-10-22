import { normalizeDecimal } from './up-mapping';

describe('normalizeDecimal', () => {
  it.each([
    ['-10.00', '-10.00'],
    ['-1000,00', '-1000.00'],
    ['1.234,56', '1234.56'],
    ['-1,234.56', '-1234.56'],
    ['5', '5'],
    ['0,5', '0.5'],
  ])('%s -> %s', (input, expected) => expect(normalizeDecimal(input)).toBe(expected));

  it('rejects junk', () => expect(() => normalizeDecimal('abc')).toThrow());
});
