import { dec } from '../common/decimal';
import { ValidationError } from '../common/errors';
import { resolveTransfer } from './transfer-math';

const str = (r: ReturnType<typeof resolveTransfer>) => ({
  fromAmount: r.fromAmount.toFixed(),
  toAmount: r.toAmount.toFixed(),
  rate: r.rate.toFixed(),
  fees: r.fees.toFixed(),
  calculatedField: r.calculatedField,
});

describe('resolveTransfer', () => {
  it('moves the full amount at rate 1 within one currency', () => {
    expect(str(resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'AUD', fromAmount: dec('500.25') }))).toEqual({
      fromAmount: '500.25', toAmount: '500.25', rate: '1', fees: '0', calculatedField: 'toAmount',
    });
    expect(resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'AUD', toAmount: dec('10') }).calculatedField).toBe('fromAmount');
    expect(resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'AUD', fromAmount: dec('10'), toAmount: dec('10.00'), rate: dec('1') }).calculatedField).toBeNull();
  });

  it('keeps fees separate from the amount that arrives', () => {
    expect(str(resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'AUD', fromAmount: dec('100'), fees: dec('1.5') }))).toMatchObject({
      fromAmount: '100', toAmount: '100', fees: '1.5',
    });
  });

  it('rejects same-currency transfers whose amounts differ, a rate other than 1, no amount, or negative fees', () => {
    expect(() => resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'AUD', fromAmount: dec('100'), toAmount: dec('99') })).toThrow(/must equal fromAmount/);
    expect(() => resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'AUD', fromAmount: dec('100'), rate: dec('0.65') })).toThrow(/rate 1/);
    expect(() => resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'AUD' })).toThrow(ValidationError);
    expect(() => resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'AUD', fromAmount: dec('0') })).toThrow(/greater than zero/);
    expect(() => resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'AUD', fromAmount: dec('1'), fees: dec('-1') })).toThrow(/fees/);
  });

  it('calculates the missing FX figure between currencies, rounding amounts to the minor unit', () => {
    expect(str(resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: dec('1000'), rate: dec('0.6543') }))).toEqual({
      fromAmount: '1000', toAmount: '654.3', rate: '0.6543', fees: '0', calculatedField: 'toAmount',
    });
    expect(str(resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'USD', toAmount: dec('650'), rate: dec('0.65') }))).toMatchObject({
      fromAmount: '1000', calculatedField: 'fromAmount',
    });
    expect(str(resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'JPY', fromAmount: dec('100'), toAmount: dec('9876') }))).toMatchObject({
      rate: '98.76', calculatedField: 'rate',
    });
    expect(resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'JPY', fromAmount: dec('100'), rate: dec('98.765') }).toAmount.toFixed()).toBe('9877');
  });

  it('requires two FX figures between currencies and checks that three agree', () => {
    expect(() => resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: dec('100') })).toThrow(/two of/);
    expect(() => resolveTransfer({ fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: dec('100'), toAmount: dec('70'), rate: dec('0.65') })).toThrow(/does not match/);
  });
});
