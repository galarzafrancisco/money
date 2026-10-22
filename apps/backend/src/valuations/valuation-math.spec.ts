import { dec } from '../common/decimal';
import type { LedgerEntry } from '../ledger/ledger.types';
import type { DailyCloseSeries } from '../market-prices/market-price.port';
import { settledThrough } from './valuation-job.service';
import { positionsByDate, priceHolding } from './valuation-math';

let seq = 0;
const deposit = (date: string, amount: string): LedgerEntry => ({ id: `d${++seq}`, date, sequence: seq, type: 'DEPOSIT', currency: 'USD', amount: dec(amount) });
const trade = (type: 'BUY' | 'SELL', date: string, quantity: string, unitPrice: string): LedgerEntry => ({
  id: `${type}${++seq}`,
  date,
  sequence: seq,
  type,
  symbol: 'VOO',
  currency: 'USD',
  quantity: dec(quantity),
  unitPrice: dec(unitPrice),
  fees: dec(0),
  total: dec(quantity).times(unitPrice),
});

describe('positionsByDate', () => {
  it('uses the quantities held at the end of each date, not today\'s', () => {
    const entries = [deposit('2025-01-01', '10000'), trade('BUY', '2025-01-02', '10', '100'), trade('BUY', '2025-01-04', '5', '110'), trade('SELL', '2025-01-06', '12', '120')];
    const byDate = positionsByDate(entries, ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04', '2025-01-06', '2025-01-07']);
    const qty = (date: string) => byDate.get(date)!.map((p) => `${p.symbol}:${p.quantity.toString()}`);
    expect(qty('2025-01-01')).toEqual([]);
    expect(qty('2025-01-02')).toEqual(['VOO:10']);
    expect(qty('2025-01-03')).toEqual(['VOO:10']);
    expect(qty('2025-01-04')).toEqual(['VOO:15']);
    // FIFO: the sale of 12 empties the first lot and takes 2 of the second
    expect(qty('2025-01-06')).toEqual(['VOO:3']);
    const lots = byDate.get('2025-01-07')![0].lots;
    expect(lots.map((l) => [l.acquiredOn, l.remainingQuantity.toString(), l.remainingCostBase.toString()])).toEqual([['2025-01-04', '3', '330']]);
  });

  it('drops a position once it is sold out', () => {
    const entries = [deposit('2025-01-01', '1000'), trade('BUY', '2025-01-02', '1', '100'), trade('SELL', '2025-01-03', '1', '100')];
    expect(positionsByDate(entries, ['2025-01-02', '2025-01-03']).get('2025-01-03')).toEqual([]);
  });
});

describe('priceHolding', () => {
  const series = (closes: [string, string][], currency = 'USD'): { series: DailyCloseSeries } => ({
    series: {
      symbol: 'VOO',
      currency,
      exchangeTimezone: 'America/New_York',
      source: 'test',
      isMock: false,
      adjustment: 'AS_TRADED',
      splits: [],
      closes: closes.map(([tradingDate, close]) => ({ tradingDate, close, closeTime: null })),
    },
  });
  const position = { symbol: 'VOO', currency: 'USD', quantity: dec('10') };

  it('values at the close of the valuation date', () => {
    const priced = priceHolding(position, '2025-03-07', series([['2025-03-06', '99'], ['2025-03-07', '100']]), 7);
    expect(priced).toMatchObject({ status: 'CLOSE', close: { tradingDate: '2025-03-07', close: '100' } });
    expect(priced.marketValue!.toString()).toBe('1000');
  });

  it('uses the last close on weekends and on holidays revealed by a later session', () => {
    const s = series([['2025-03-07', '100'], ['2025-03-11', '105']]);
    expect(priceHolding(position, '2025-03-08', s, 7)).toMatchObject({ status: 'NON_TRADING_DAY', close: { tradingDate: '2025-03-07' } });
    // Monday 10th: no session, but there is one on the 11th
    expect(priceHolding(position, '2025-03-10', s, 7)).toMatchObject({ status: 'NON_TRADING_DAY', close: { tradingDate: '2025-03-07' } });
  });

  it('flags a weekday without a close (yet) as pending, not as a fresh close', () => {
    const priced = priceHolding(position, '2025-03-10', series([['2025-03-07', '100']]), 7);
    expect(priced.status).toBe('PRICE_PENDING');
    expect(priced.close!.tradingDate).toBe('2025-03-07');
    expect(priced.note).toMatch(/provisionally/);
  });

  it('does not value without a usable close', () => {
    expect(priceHolding(position, '2025-03-10', { error: 'provider down' }, 7)).toMatchObject({ status: 'MISSING', marketValue: null, note: 'provider down' });
    expect(priceHolding(position, '2025-03-10', { series: null }, 7)).toMatchObject({ status: 'MISSING', marketValue: null });
    expect(priceHolding(position, '2025-03-20', series([['2025-03-07', '100']]), 7)).toMatchObject({ status: 'MISSING', marketValue: null });
    expect(priceHolding(position, '2025-03-07', series([['2025-03-07', '100']], 'AUD'), 7)).toMatchObject({ status: 'CURRENCY_MISMATCH', marketValue: null });
  });
});

describe('settledThrough', () => {
  it('makes date D due at D+1 06:00 UTC', () => {
    expect(settledThrough(new Date('2025-03-12T05:59:00Z'), 6)).toBe('2025-03-10');
    expect(settledThrough(new Date('2025-03-12T06:00:00Z'), 6)).toBe('2025-03-11');
  });
});
