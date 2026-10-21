import { dec } from '../common/decimal';
import { ValidationError } from '../common/errors';
import { resolveDividend, resolveFx, resolveTrade } from './trade-math';

const s = (value: { toFixed(): string }) => value.toFixed();

describe('resolveTrade (three of four)', () => {
  it('calculates the total of a buy: quantity × price + fees', () => {
    const t = resolveTrade('BUY', 'USD', { quantity: dec('10'), unitPrice: dec('450.25'), fees: dec('3') });
    expect(s(t.total)).toBe('4505.5');
    expect(t.calculatedField).toBe('total');
  });

  it('calculates the total of a sell: quantity × price − fees', () => {
    const t = resolveTrade('SELL', 'USD', { quantity: dec('10'), unitPrice: dec('450.25'), fees: dec('3') });
    expect(s(t.total)).toBe('4499.5');
  });

  it('rounds a calculated total to cents', () => {
    const t = resolveTrade('BUY', 'AUD', { quantity: dec('3'), unitPrice: dec('33.333'), fees: dec('0') });
    expect(s(t.total)).toBe('100');
  });

  it('calculates fees from the total', () => {
    const t = resolveTrade('BUY', 'AUD', { quantity: dec('100'), unitPrice: dec('95.12'), total: dec('9521.95') });
    expect(s(t.fees)).toBe('9.95');
    expect(t.calculatedField).toBe('fees');
    const sell = resolveTrade('SELL', 'AUD', { quantity: dec('100'), unitPrice: dec('95.12'), total: dec('9502.05') });
    expect(s(sell.fees)).toBe('9.95');
  });

  it('calculates a fractional quantity', () => {
    const t = resolveTrade('BUY', 'USD', { unitPrice: dec('300'), fees: dec('0'), total: dec('100') });
    expect(s(t.quantity)).toBe('0.3333333333');
    expect(t.calculatedField).toBe('quantity');
    expect(s(t.total)).toBe('100');
  });

  it('calculates the unit price', () => {
    const t = resolveTrade('BUY', 'USD', { quantity: dec('4'), fees: dec('2'), total: dec('402') });
    expect(s(t.unitPrice)).toBe('100');
  });

  it('accepts four consistent values within 0.01', () => {
    const t = resolveTrade('BUY', 'USD', { quantity: dec('3'), unitPrice: dec('33.3333'), fees: dec('1'), total: dec('101') });
    expect(t.calculatedField).toBeNull();
    expect(s(t.total)).toBe('101');
  });

  it('rejects four inconsistent values', () => {
    expect(() => resolveTrade('BUY', 'USD', { quantity: dec('10'), unitPrice: dec('10'), fees: dec('1'), total: dec('110') })).toThrow(
      /does not match total/,
    );
  });

  it('rejects fewer than three values and names what is missing', () => {
    expect(() => resolveTrade('BUY', 'USD', { quantity: dec('10'), unitPrice: dec('10') })).toThrow(/missing fees and total/);
    expect(() => resolveTrade('SELL', 'USD', {})).toThrow(ValidationError);
  });

  it('rejects totals that imply negative fees', () => {
    expect(() => resolveTrade('BUY', 'USD', { quantity: dec('10'), unitPrice: dec('10'), total: dec('90') })).toThrow(/negative fees/);
  });

  it('rejects zero or negative quantities and negative values', () => {
    expect(() => resolveTrade('BUY', 'USD', { quantity: dec('0'), unitPrice: dec('10'), fees: dec('0') })).toThrow(/quantity/);
    expect(() => resolveTrade('BUY', 'USD', { quantity: dec('1'), unitPrice: dec('-1'), fees: dec('0') })).toThrow(/unitPrice/);
    expect(() => resolveTrade('BUY', 'USD', { quantity: dec('1'), unitPrice: dec('1'), fees: dec('-1') })).toThrow(/fees/);
  });

  it('rejects a sale whose fees exceed its value', () => {
    expect(() => resolveTrade('SELL', 'USD', { quantity: dec('1'), unitPrice: dec('1'), fees: dec('5') })).toThrow(/negative/);
  });

  it('cannot derive a quantity from a zero price', () => {
    expect(() => resolveTrade('BUY', 'USD', { unitPrice: dec('0'), fees: dec('0'), total: dec('10') })).toThrow(/unitPrice is zero/);
  });
});

describe('resolveDividend (two of three)', () => {
  it('calculates net from gross and withholding', () => {
    const d = resolveDividend('USD', { grossAmount: dec('100'), withholdingTax: dec('15') });
    expect(s(d.netAmount)).toBe('85');
    expect(d.calculatedField).toBe('netAmount');
  });

  it('calculates withholding from gross and net', () => {
    expect(s(resolveDividend('USD', { grossAmount: dec('100'), netAmount: dec('70') }).withholdingTax)).toBe('30');
  });

  it('calculates gross from net and withholding', () => {
    expect(s(resolveDividend('USD', { withholdingTax: dec('15'), netAmount: dec('85') }).grossAmount)).toBe('100');
  });

  it('rejects inconsistent or underdetermined input', () => {
    expect(() => resolveDividend('USD', { grossAmount: dec('100'), withholdingTax: dec('15'), netAmount: dec('80') })).toThrow(/does not match/);
    expect(() => resolveDividend('USD', { grossAmount: dec('100') })).toThrow(/at least two/);
    expect(() => resolveDividend('USD', { grossAmount: dec('10'), withholdingTax: dec('15') })).toThrow(/larger than grossAmount/);
  });
});

describe('resolveFx (two of three)', () => {
  it('calculates the rate from both amounts', () => {
    const fx = resolveFx('USD', 'AUD', { fromAmount: dec('1000'), toAmount: dec('652.3') });
    expect(s(fx.rate)).toBe('0.6523');
  });

  it('calculates the received amount from the rate, rounded to cents', () => {
    expect(s(resolveFx('USD', 'AUD', { fromAmount: dec('1000'), rate: dec('0.65234') }).toAmount)).toBe('652.34');
  });

  it('calculates the sold amount from the rate', () => {
    expect(s(resolveFx('AUD', 'USD', { toAmount: dec('1530'), rate: dec('1.53') }).fromAmount)).toBe('1000');
  });

  it('rejects inconsistent input', () => {
    expect(() => resolveFx('USD', 'AUD', { fromAmount: dec('1000'), toAmount: dec('600'), rate: dec('0.65') })).toThrow(/does not match/);
    expect(() => resolveFx('USD', 'AUD', { fromAmount: dec('1000') })).toThrow(/at least two/);
  });
});
