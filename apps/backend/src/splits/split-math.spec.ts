import { dec, fmt } from '../common/decimal';
import { replayLedger } from '../ledger/ledger-engine';
import type { LedgerEntry, TradeEntry } from '../ledger/ledger.types';
import { holdingsOn, positionsByDate, type SeriesResult } from '../valuations/valuation-math';
import { factorAfter, positionOnDate, recordedOn, sameSplits, splitsBetween, toPresentBasis, type SplitIndex, type StockSplit } from './split-math';

const split = (effectiveDate: string, numerator: string, denominator = '1', instrument = 'TSLA'): StockSplit => ({
  instrument,
  effectiveDate,
  numerator,
  denominator,
  provenance: 'VERIFIED',
  source: 'test',
  note: null,
});

const TSLA = [split('2020-08-31', '5'), split('2022-08-25', '3')];
const index: SplitIndex = new Map([['TSLA', TSLA]]);

let seq = 0;
const deposit = (date: string, amount: string): LedgerEntry => ({ id: `d${++seq}`, date, sequence: seq, type: 'DEPOSIT', currency: 'USD', amount: dec(amount) });
const trade = (type: 'BUY' | 'SELL', date: string, symbol: string, quantity: string, unitPrice: string, extra: Partial<TradeEntry> = {}): TradeEntry => {
  const total = dec(quantity).times(unitPrice);
  return { id: `t${++seq}`, date, sequence: seq, type, symbol, currency: 'USD', quantity: dec(quantity), unitPrice: dec(unitPrice), fees: dec(0), total, ...extra };
};

/** As-traded TSLA closes around both splits (the figures from the bug report) */
const closes = (symbol: string, list: [string, string][]): SeriesResult => ({
  series: {
    symbol,
    currency: 'USD',
    exchangeTimezone: 'America/New_York',
    source: 'test',
    isMock: false,
    adjustment: 'AS_TRADED',
    splits: [],
    closes: list.map(([tradingDate, close]) => ({ tradingDate, close, closeTime: null })),
  },
});

describe('split factors', () => {
  it('multiplies every split after the date, none on or before it', () => {
    expect(fmt(factorAfter(TSLA, '2020-08-28'))).toBe('15');
    expect(fmt(factorAfter(TSLA, '2020-08-30'))).toBe('15');
    // The ex-date is already in the new basis
    expect(fmt(factorAfter(TSLA, '2020-08-31'))).toBe('3');
    expect(fmt(factorAfter(TSLA, '2022-08-24'))).toBe('3');
    expect(fmt(factorAfter(TSLA, '2022-08-25'))).toBe('1');
    expect(fmt(factorAfter([], '2020-01-01'))).toBe('1');
    expect(fmt(factorAfter(undefined, '2020-01-01'))).toBe('1');
  });

  it('handles reverse and fractional ratios', () => {
    expect(fmt(factorAfter([split('2024-01-02', '1', '10')], '2024-01-01'))).toBe('0.1');
    expect(fmt(factorAfter([split('2024-01-02', '3', '2'), split('2024-06-03', '2')], '2023-12-29'))).toBe('3');
  });

  it('lists the splits within (from, to]', () => {
    expect(splitsBetween(TSLA, '2020-08-28', '2022-08-25').map((s) => s.effectiveDate)).toEqual(['2020-08-31', '2022-08-25']);
    expect(splitsBetween(TSLA, '2020-08-31', '2022-08-24')).toEqual([]);
  });

  it('compares indexes by their splits', () => {
    expect(sameSplits(index, new Map([['TSLA', [...TSLA]]]))).toBe(true);
    expect(sameSplits(index, new Map([['TSLA', [TSLA[0]]]]))).toBe(false);
    expect(sameSplits(new Map(), new Map())).toBe(true);
  });

  it('takes the UTC recording date as a transaction\'s basis, today when not stored yet', () => {
    expect(recordedOn(new Date('2025-03-01T23:30:00Z'), '2026-01-01')).toBe('2025-03-01');
    expect(recordedOn(undefined, '2026-01-01')).toBe('2026-01-01');
  });
});

describe('present-basis ledger', () => {
  it('leaves trades recorded after every split untouched (no double adjustment)', () => {
    const entries = [deposit('2019-01-01', '100000'), trade('BUY', '2019-06-03', 'TSLA', '645', '15')];
    const out = toPresentBasis(entries, index, () => '2025-01-01');
    expect(out).toEqual(entries);
  });

  it('converts a trade recorded before a split into today\'s basis; cost base and cash are unchanged', () => {
    const buy = trade('BUY', '2020-08-03', 'TSLA', '10', '1500');
    const [, converted] = toPresentBasis([deposit('2020-08-01', '20000'), buy], index, (id) => (id === buy.id ? '2020-08-03' : '2026-01-01')) as [LedgerEntry, TradeEntry];
    expect(fmt(converted.quantity)).toBe('150');
    expect(fmt(converted.unitPrice)).toBe('100');
    expect(fmt(converted.total)).toBe('15000');
  });

  it('lets a sale recorded after a split match lots recorded before it, specific allocations included', () => {
    const buy = trade('BUY', '2022-08-01', 'TSLA', '10', '900');
    const sell = trade('SELL', '2022-09-01', 'TSLA', '30', '300', { allocations: [{ lotId: buy.id, quantity: dec(30) }] });
    const entries = [deposit('2022-07-01', '9000'), buy, sell];
    // Recorded as they happened: the buy before the 3:1 split, the sale after it
    const basis = (id: string) => (id === buy.id ? '2022-08-01' : id === sell.id ? '2022-09-01' : '2022-07-01');
    expect(() => replayLedger(entries)).toThrow();
    const state = replayLedger(toPresentBasis(entries, index, basis));
    expect(state.positions.size).toBe(0);
    expect(fmt(state.disposals[0].quantity)).toBe('30');
    expect(fmt(state.disposals[0].costBase)).toBe('9000');
    expect(fmt(state.disposals[0].gain)).toBe('0');
  });

  it('does not touch symbols without splits', () => {
    const entries = [deposit('2020-01-01', '1000'), trade('BUY', '2020-01-02', 'VOO', '2', '300')];
    expect(toPresentBasis(entries, index, () => '2020-01-02')).toEqual(entries);
  });
});

describe('positions in a valuation date\'s basis', () => {
  it('divides quantities and lots by the factor; cost base stays', () => {
    const state = replayLedger([deposit('2019-01-01', '100000'), trade('BUY', '2019-06-03', 'TSLA', '645', '15')]);
    const onDate = positionOnDate(state.positions.get('TSLA')!, TSLA, '2020-08-28');
    expect(fmt(onDate.quantity)).toBe('43');
    expect(fmt(onDate.presentQuantity)).toBe('645');
    expect(fmt(onDate.factor)).toBe('15');
    expect(fmt(onDate.costBase)).toBe('9675');
    expect(fmt(onDate.lots[0].remainingQuantity)).toBe('43');
    expect(fmt(onDate.lots[0].remainingCostBase)).toBe('9675');
  });
});

describe('valuation across the TSLA splits (regression)', () => {
  // The user's ledger: 645 shares (today's basis) held through 2020, 690 through 2022
  const ledger = [
    deposit('2019-01-01', '1000000'),
    trade('BUY', '2019-06-03', 'TSLA', '645', '15'),
    trade('BUY', '2021-03-01', 'TSLA', '45', '230'),
    trade('BUY', '2020-08-27', 'VOO', '10', '300'),
  ];
  const series = new Map<string, SeriesResult>([
    [
      'TSLA',
      closes('TSLA', [
        ['2020-08-27', '2238.75'],
        ['2020-08-28', '2213.40'],
        ['2020-08-31', '498.32'],
        ['2020-09-01', '475.05'],
        ['2022-08-23', '889.36'],
        ['2022-08-24', '891.29'],
        ['2022-08-25', '296.07'],
        ['2022-08-26', '288.09'],
      ]),
    ],
    ['VOO', closes('VOO', [['2020-08-27', '320'], ['2020-08-28', '322'], ['2020-08-31', '321'], ['2020-09-01', '324']])],
  ]);
  const dates = ['2020-08-27', '2020-08-28', '2020-08-29', '2020-08-30', '2020-08-31', '2020-09-01', '2022-08-23', '2022-08-24', '2022-08-25', '2022-08-26'];
  const positions = [{ accountId: 'a1', byDate: positionsByDate(toPresentBasis(ledger, index, () => '2025-10-01'), dates) }];
  const value = (date: string, symbol = 'TSLA') => holdingsOn(positions, date, series, 7, index).find((h) => h.symbol === symbol)!;

  it('has no cliff at the 2020-08-31 5:1 split', () => {
    const before = value('2020-08-28');
    const after = value('2020-08-31');
    expect(before).toMatchObject({ quantity: '43', closePrice: '2213.4', marketValue: '95176.2', splitFactor: '15', splitAdjustedQuantity: '645', splitAdjustedClose: '147.56' });
    expect(after).toMatchObject({ quantity: '215', closePrice: '498.32', marketValue: '107138.8', splitFactor: '3', splitAdjustedQuantity: '645' });
    // The real move that day (+12.6%) survives; the artificial -77% does not
    const change = dec(after.marketValue!).dividedBy(before.marketValue!).minus(1);
    expect(change.toNumber()).toBeCloseTo(0.1257, 3);
    expect(after.priceNote).toMatch(/TSLA split 5:1 on 2020-08-31 while held/);
  });

  it('carries the pre-split basis over the weekend before the split', () => {
    expect(value('2020-08-29')).toMatchObject({ priceStatus: 'NON_TRADING_DAY', quantity: '43', closePrice: '2213.4', marketValue: '95176.2', splitFactor: '15' });
    expect(value('2020-08-30')).toMatchObject({ quantity: '43', marketValue: '95176.2' });
  });

  it('has no cliff at the 2022-08-25 3:1 split', () => {
    const before = value('2022-08-24');
    const after = value('2022-08-25');
    expect(before).toMatchObject({ quantity: '230', closePrice: '891.29', marketValue: '204996.7', splitFactor: '3', splitAdjustedQuantity: '690' });
    expect(after).toMatchObject({ quantity: '690', closePrice: '296.07', marketValue: '204288.3', splitFactor: '1', splitAdjustedClose: '296.07' });
    expect(dec(after.marketValue!).dividedBy(before.marketValue!).minus(1).abs().toNumber()).toBeLessThan(0.01);
  });

  it('keeps value invariant across a split absent market movement', () => {
    const flat = new Map<string, SeriesResult>([['TSLA', closes('TSLA', [['2022-08-24', '900'], ['2022-08-25', '300']])]]);
    const v = (date: string) => holdingsOn(positions, date, flat, 7, index).find((h) => h.symbol === 'TSLA')!.marketValue;
    expect(v('2022-08-24')).toBe('207000');
    expect(v('2022-08-25')).toBe('207000');
  });

  it('leaves holdings without splits as they were', () => {
    expect(value('2020-08-28', 'VOO')).toMatchObject({ quantity: '10', marketValue: '3220', splitFactor: '1', splitAdjustedQuantity: '10', splitAdjustedClose: '322', priceNote: null });
    expect(value('2020-08-31', 'VOO')).toMatchObject({ quantity: '10', marketValue: '3210' });
  });

  it('values lots in the date\'s basis too', () => {
    const lots = value('2022-08-24').lots;
    expect(lots.map((l) => [l.quantity, l.costBase, l.marketValue])).toEqual([
      ['215', '9675', '191627.35'],
      ['15', '10350', '13369.35'],
    ]);
  });
});
