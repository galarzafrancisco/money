import { dec } from '../common/decimal';
import { LedgerViolationError } from '../common/errors';
import { heldOverTwelveMonths, replayLedger } from './ledger-engine';
import type { LedgerEntry } from './ledger.types';

let seq = 0;
const at = (date: string) => ({ id: `t${++seq}`, date, sequence: seq });
const deposit = (date: string, currency: string, amount: string): LedgerEntry => ({ ...at(date), type: 'DEPOSIT', currency, amount: dec(amount) });
const withdraw = (date: string, currency: string, amount: string): LedgerEntry => ({ ...at(date), type: 'WITHDRAWAL', currency, amount: dec(amount) });
const fx = (date: string, from: string, fromAmount: string, to: string, toAmount: string, fees = '0'): LedgerEntry => ({
  ...at(date), type: 'FX_CONVERSION', fromCurrency: from, fromAmount: dec(fromAmount), toCurrency: to, toAmount: dec(toAmount), fees: dec(fees),
});
const trade = (type: 'BUY' | 'SELL', date: string, symbol: string, quantity: string, unitPrice: string, fees: string, currency = 'USD'): LedgerEntry => {
  const gross = dec(quantity).times(unitPrice);
  return { ...at(date), type, symbol, currency, quantity: dec(quantity), unitPrice: dec(unitPrice), fees: dec(fees), total: type === 'BUY' ? gross.plus(fees) : gross.minus(fees) };
};
const dividend = (date: string, symbol: string, gross: string, withholding: string, currency = 'USD', franking = '0'): LedgerEntry => ({
  ...at(date), type: 'DIVIDEND', symbol, currency, grossAmount: dec(gross), withholdingTax: dec(withholding), netAmount: dec(gross).minus(withholding), frankingCredits: dec(franking),
});

const cash = (state: ReturnType<typeof replayLedger>, currency: string) => state.cash.get(currency)?.toFixed();

describe('replayLedger: cash and FX', () => {
  it('tracks every currency separately through deposits, conversions and withdrawals', () => {
    const state = replayLedger([
      deposit('2025-01-01', 'AUD', '10000'),
      fx('2025-01-02', 'AUD', '6000', 'USD', '3900', '5'),
      deposit('2025-01-03', 'USD', '100'),
      withdraw('2025-01-04', 'AUD', '995'),
    ]);
    expect(cash(state, 'AUD')).toBe('3000');
    expect(cash(state, 'USD')).toBe('4000');
  });

  it('rejects a withdrawal larger than the balance in that currency', () => {
    expect(() => replayLedger([deposit('2025-01-01', 'AUD', '100'), withdraw('2025-01-02', 'USD', '1')])).toThrow(LedgerViolationError);
  });

  it('includes FX fees in the amount debited', () => {
    expect(() => replayLedger([deposit('2025-01-01', 'AUD', '100'), fx('2025-01-02', 'AUD', '100', 'USD', '65', '1')])).toThrow(/Not enough AUD/);
  });

  it('orders by date, not by insertion, so a back-dated deposit funds a later buy', () => {
    const buy = trade('BUY', '2025-02-01', 'VOO', '1', '500', '0');
    const late = deposit('2025-01-15', 'USD', '500');
    expect(cash(replayLedger([buy, late]), 'USD')).toBe('0');
  });
});

describe('replayLedger: buys, sells and cost bases', () => {
  it('builds lots whose cost base includes brokerage', () => {
    const state = replayLedger([deposit('2025-01-01', 'USD', '10000'), trade('BUY', '2025-01-02', 'VOO', '10', '400', '5')]);
    const voo = state.positions.get('VOO')!;
    expect(voo.quantity.toFixed()).toBe('10');
    expect(voo.costBase.toFixed()).toBe('4005');
    expect(cash(state, 'USD')).toBe('5995');
  });

  it('matches sales FIFO across lots and splits cost base and proceeds', () => {
    const state = replayLedger([
      deposit('2024-01-01', 'USD', '10000'),
      trade('BUY', '2024-01-10', 'TSLA', '10', '100', '10'), // lot A: 1010
      trade('BUY', '2024-06-01', 'TSLA', '10', '200', '10'), // lot B: 2010
      trade('SELL', '2025-01-11', 'TSLA', '15', '300', '15'), // proceeds 4485
    ]);
    const [a, b] = state.disposals;
    expect(a.quantity.toFixed()).toBe('10');
    expect(a.costBase.toFixed()).toBe('1010');
    expect(a.proceeds.toFixed()).toBe('2990');
    expect(a.gain.toFixed()).toBe('1980');
    expect(a.heldOverTwelveMonths).toBe(true);
    expect(b.quantity.toFixed()).toBe('5');
    expect(b.costBase.toFixed()).toBe('1005');
    expect(b.proceeds.toFixed()).toBe('1495');
    expect(b.heldOverTwelveMonths).toBe(false);
    expect(a.proceeds.plus(b.proceeds).toFixed()).toBe('4485');

    const remaining = state.positions.get('TSLA')!;
    expect(remaining.quantity.toFixed()).toBe('5');
    expect(remaining.costBase.toFixed()).toBe('1005');
    expect(remaining.lots).toHaveLength(1);
    expect(cash(state, 'USD')).toBe(dec('10000').minus(1010).minus(2010).plus(4485).toFixed());
  });

  it('removes a position that is sold out but keeps its realized history', () => {
    const state = replayLedger([
      deposit('2025-01-01', 'USD', '1000'),
      trade('BUY', '2025-01-02', 'AAPL', '2', '100', '0'),
      trade('SELL', '2025-01-03', 'AAPL', '2', '90', '0'),
    ]);
    expect(state.positions.has('AAPL')).toBe(false);
    expect(state.disposals[0].gain.toFixed()).toBe('-20');
  });

  it('handles fractional shares without drift', () => {
    const state = replayLedger([
      deposit('2025-01-01', 'USD', '1000'),
      trade('BUY', '2025-01-02', 'VOO', '0.3333333333', '300', '0'),
      trade('SELL', '2025-01-03', 'VOO', '0.1111111111', '300', '0'),
      trade('SELL', '2025-01-04', 'VOO', '0.2222222222', '300', '0'),
    ]);
    expect(state.positions.has('VOO')).toBe(false);
    const totalCost = state.disposals.reduce((sum, d) => sum.plus(d.costBase), dec(0));
    expect(totalCost.toFixed()).toBe(dec('0.3333333333').times(300).toFixed());
  });

  it('rejects selling more than is held at that date', () => {
    expect(() =>
      replayLedger([deposit('2025-01-01', 'USD', '1000'), trade('BUY', '2025-01-05', 'VOO', '1', '100', '0'), trade('SELL', '2025-01-04', 'VOO', '1', '100', '0')]),
    ).toThrow(/only 0 held/);
  });

  it('rejects a buy without enough cash', () => {
    expect(() => replayLedger([deposit('2025-01-01', 'USD', '100'), trade('BUY', '2025-01-02', 'VOO', '1', '100', '1')])).toThrow(/Not enough USD/);
  });

  it('rejects trading a ticker in two currencies within an account', () => {
    expect(() =>
      replayLedger([
        deposit('2025-01-01', 'USD', '1000'),
        deposit('2025-01-01', 'AUD', '1000'),
        trade('BUY', '2025-01-02', 'VOO', '1', '100', '0', 'USD'),
        trade('BUY', '2025-01-03', 'VOO', '1', '100', '0', 'AUD'),
      ]),
    ).toThrow(/traded in USD/);
  });
});

describe('replayLedger: dividends', () => {
  it('credits net cash and totals gross, withholding and franking credits', () => {
    const state = replayLedger([
      dividend('2025-03-01', 'VOO', '100', '15'),
      dividend('2025-06-01', 'VOO', '50', '7.5'),
      dividend('2025-04-01', 'VAS.AX', '70', '0', 'AUD', '30'),
    ]);
    expect(cash(state, 'USD')).toBe('127.5');
    expect(cash(state, 'AUD')).toBe('70');
    const usd = state.dividends.get('USD')!;
    expect(usd.grossAmount.toFixed()).toBe('150');
    expect(usd.withholdingTax.toFixed()).toBe('22.5');
    expect(state.dividends.get('AUD')!.frankingCredits.toFixed()).toBe('30');
    expect(state.dividendsBySymbol.get('VOO|USD')!.netAmount.toFixed()).toBe('127.5');
  });
});

describe('heldOverTwelveMonths', () => {
  it('excludes the days of acquisition and disposal', () => {
    expect(heldOverTwelveMonths('2024-01-10', '2025-01-10')).toBe(false);
    expect(heldOverTwelveMonths('2024-01-10', '2025-01-11')).toBe(true);
  });

  it('handles 29 February', () => {
    expect(heldOverTwelveMonths('2024-02-29', '2025-02-28')).toBe(false);
    expect(heldOverTwelveMonths('2024-02-29', '2025-03-01')).toBe(true);
  });
});

describe('replayLedger: transfer legs', () => {
  const leg = (type: 'TRANSFER_OUT' | 'TRANSFER_IN', date: string, currency: string, amount: string, fees = '0'): LedgerEntry => ({
    ...at(date), type, currency, amount: dec(amount), fees: dec(fees),
  });

  it('debits amount plus fees on the way out and credits the amount on the way in, per currency', () => {
    const state = replayLedger([
      deposit('2025-01-01', 'AUD', '1000'),
      leg('TRANSFER_OUT', '2025-01-02', 'AUD', '600', '2.5'),
      leg('TRANSFER_IN', '2025-01-03', 'USD', '390'),
    ]);
    expect(cash(state, 'AUD')).toBe('397.5');
    expect(cash(state, 'USD')).toBe('390');
  });

  it('rejects a transfer out that the balance on that date cannot cover, including fees', () => {
    const out = leg('TRANSFER_OUT', '2025-01-02', 'AUD', '1000', '0.01');
    expect(() => replayLedger([deposit('2025-01-01', 'AUD', '1000'), out])).toThrow(LedgerViolationError);
    try {
      replayLedger([deposit('2025-01-01', 'AUD', '1000'), out]);
    } catch (error) {
      expect((error as LedgerViolationError).details).toMatchObject({ transactionId: out.id, currency: 'AUD', required: '1000.01', available: '1000' });
    }
  });

  it('lets money that arrived by transfer fund later activity, but not earlier activity', () => {
    expect(() => replayLedger([leg('TRANSFER_IN', '2025-01-05', 'USD', '100'), withdraw('2025-01-06', 'USD', '100')])).not.toThrow();
    expect(() => replayLedger([leg('TRANSFER_IN', '2025-01-05', 'USD', '100'), withdraw('2025-01-04', 'USD', '100')])).toThrow(LedgerViolationError);
  });
});

describe('replayLedger: gain/loss', () => {
  const gainLoss = (date: string, currency: string, amount: string): LedgerEntry => ({ ...at(date), type: 'GAIN_LOSS', currency, amount: dec(amount) });

  it('adds a gain and subtracts a loss without being a deposit or withdrawal', () => {
    const state = replayLedger([deposit('2025-01-01', 'AUD', '1000'), gainLoss('2025-02-01', 'AUD', '75.5'), gainLoss('2025-03-01', 'AUD', '-20')]);
    expect(cash(state, 'AUD')).toBe('1055.5');
  });

  it('rejects a loss larger than the balance', () => {
    expect(() => replayLedger([deposit('2025-01-01', 'AUD', '100'), gainLoss('2025-02-01', 'AUD', '-101')])).toThrow(LedgerViolationError);
  });
});
