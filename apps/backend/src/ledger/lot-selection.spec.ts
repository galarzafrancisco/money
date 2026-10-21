import { ZERO, dec, fmt } from '../common/decimal';
import { LedgerViolationError } from '../common/errors';
import { positionsByDate } from '../valuations/valuation-math';
import { daysBetweenDates, replayLedger } from './ledger-engine';
import type { LedgerEntry, TradeEntry } from './ledger.types';

let seq = 0;
const at = (date: string, id?: string) => ({ id: id ?? `t${++seq}`, date, sequence: ++seq });
const deposit = (date: string, amount: string): LedgerEntry => ({ ...at(date), type: 'DEPOSIT', currency: 'USD', amount: dec(amount) });
const buy = (id: string, date: string, quantity: string, unitPrice: string, fees = '0', symbol = 'VOO'): TradeEntry => {
  const total = dec(quantity).times(unitPrice).plus(fees);
  return { ...at(date, id), type: 'BUY', symbol, currency: 'USD', quantity: dec(quantity), unitPrice: dec(unitPrice), fees: dec(fees), total };
};
const sell = (
  id: string,
  date: string,
  quantity: string,
  unitPrice: string,
  fees = '0',
  allocations?: [string, string][],
  symbol = 'VOO',
): TradeEntry => ({
  ...at(date, id),
  type: 'SELL',
  symbol,
  currency: 'USD',
  quantity: dec(quantity),
  unitPrice: dec(unitPrice),
  fees: dec(fees),
  total: dec(quantity).times(unitPrice).minus(fees),
  ...(allocations ? { allocations: allocations.map(([lotId, q]) => ({ lotId, quantity: dec(q) })) } : {}),
});

const remaining = (state: ReturnType<typeof replayLedger>, lotId: string) => fmt(state.lotsById.get(lotId)!.remainingQuantity);

describe('specific lot identification', () => {
  it('sells 40 as 15 from lot A (100) and 25 from lot B (200), leaving 85 and 175', () => {
    const state = replayLedger([
      deposit('2024-01-01', '100000'),
      buy('A', '2024-01-10', '100', '10'),
      buy('B', '2024-06-10', '200', '20'),
      sell('S', '2025-03-01', '40', '30', '0', [['A', '15'], ['B', '25']]),
    ]);
    expect(remaining(state, 'A')).toBe('85');
    expect(remaining(state, 'B')).toBe('175');
    expect(fmt(state.positions.get('VOO')!.quantity)).toBe('260');
    const [a, b] = state.disposals;
    expect(a).toMatchObject({ lotId: 'A', selection: 'SPECIFIC', heldOverTwelveMonths: true });
    expect(fmt(a.costBase)).toBe('150');
    expect(fmt(a.gain)).toBe('300');
    expect(b).toMatchObject({ lotId: 'B', selection: 'SPECIFIC', heldOverTwelveMonths: false, daysHeld: daysBetweenDates('2024-06-10', '2025-03-01') });
    expect(fmt(b.costBase)).toBe('500');
    expect(fmt(b.gain)).toBe('250');
  });

  it('is not FIFO: the same sale without allocations would take all 40 from lot A', () => {
    const state = replayLedger([deposit('2024-01-01', '100000'), buy('A', '2024-01-10', '100', '10'), buy('B', '2024-06-10', '200', '20'), sell('S', '2025-03-01', '40', '30')]);
    expect(remaining(state, 'A')).toBe('60');
    expect(remaining(state, 'B')).toBe('200');
    expect(state.disposals.map((d) => d.selection)).toEqual(['FIFO']);
  });

  it('supports repeated partial sales from the same lots, down to zero', () => {
    const state = replayLedger([
      deposit('2024-01-01', '100000'),
      buy('A', '2024-01-10', '100', '10'),
      buy('B', '2024-06-10', '200', '20'),
      sell('S1', '2025-03-01', '40', '30', '0', [['A', '15'], ['B', '25']]),
      sell('S2', '2025-03-02', '100', '30', '0', [['B', '100']]),
      sell('S3', '2025-03-03', '85', '30', '0', [['A', '85']]),
    ]);
    expect(remaining(state, 'A')).toBe('0');
    expect(remaining(state, 'B')).toBe('75');
    expect(fmt(state.lotsById.get('A')!.remainingCostBase)).toBe('0');
    expect([...state.positions.get('VOO')!.lots.map((l) => l.lotId)]).toEqual(['B']);
  });

  it('tells apart several purchases on the same date', () => {
    const state = replayLedger([
      deposit('2024-01-01', '100000'),
      buy('M1', '2024-05-01', '10', '10'),
      buy('M2', '2024-05-01', '10', '12'),
      buy('M3', '2024-05-01', '10', '14'),
      sell('S', '2024-07-01', '12', '20', '0', [['M3', '10'], ['M1', '2']]),
    ]);
    expect(remaining(state, 'M1')).toBe('8');
    expect(remaining(state, 'M2')).toBe('10');
    expect(remaining(state, 'M3')).toBe('0');
    expect(state.disposals.map((d) => [d.lotId, fmt(d.costBase)])).toEqual([['M3', '140'], ['M1', '20']]);
  });

  it('shares fees and proceeds pro-rata at 10 dp, with the totals reconciling exactly', () => {
    const state = replayLedger([
      deposit('2024-01-01', '100000'),
      buy('A', '2024-01-10', '3', '10', '1'), // cost 31: one third is not exact
      buy('B', '2024-01-11', '3', '10', '1'),
      buy('C', '2024-01-12', '3', '10', '1'),
      sell('S', '2024-02-01', '7', '11.11', '9.99', [['A', '1'], ['B', '3'], ['C', '3']]),
    ]);
    const sale = state.disposals;
    const sum = (pick: (d: (typeof sale)[number]) => ReturnType<typeof dec>) => sale.reduce((t, d) => t.plus(pick(d)), ZERO);
    const total = dec('7').times('11.11').minus('9.99');
    expect(sum((d) => d.proceeds).eq(total)).toBe(true);
    expect(sum((d) => d.fees).eq('9.99')).toBe(true);
    expect(sum((d) => d.grossProceeds).eq(total.plus('9.99'))).toBe(true);
    expect(fmt(sale[0].fees)).toBe('1.4271428571');
    expect(fmt(sale[0].costBase)).toBe('10.3333333333');
    expect(fmt(sale[1].costBase)).toBe('31'); // the whole lot, not 3 × a rounded unit cost
    // What is left of lot A plus what was sold is exactly its cost
    expect(state.lotsById.get('A')!.remainingCostBase.plus(sale[0].costBase).eq(31)).toBe(true);
    for (const d of sale) {
      expect(d.costBase.decimalPlaces()).toBeLessThanOrEqual(10);
      expect(d.gain.eq(d.proceeds.minus(d.costBase))).toBe(true);
      expect(d.grossProceeds.minus(d.fees).eq(d.proceeds)).toBe(true);
    }
  });

  it('mixes with FIFO sales: FIFO takes the oldest lots still open after explicit picks', () => {
    const state = replayLedger([
      deposit('2024-01-01', '100000'),
      buy('A', '2024-01-10', '100', '10'),
      buy('B', '2024-06-10', '200', '20'),
      sell('S1', '2025-03-01', '100', '30', '0', [['A', '100']]),
      sell('S2', '2025-03-02', '50', '30'),
    ]);
    expect(state.disposals.filter((d) => d.sellTransactionId === 'S2').map((d) => [d.lotId, d.selection])).toEqual([['B', 'FIFO']]);
    expect(remaining(state, 'B')).toBe('150');
  });

  describe('rejects', () => {
    const base = () => [deposit('2024-01-01', '100000'), buy('A', '2024-01-10', '100', '10'), buy('B', '2024-06-10', '200', '20'), buy('X', '2024-06-10', '5', '50', '0', 'TSLA')];
    const reject = (s: TradeEntry, extra: LedgerEntry[] = [], pattern?: RegExp) => {
      const run = () => replayLedger([...base(), ...extra, s]);
      expect(run).toThrow(LedgerViolationError);
      if (pattern) expect(run).toThrow(pattern);
    };

    it('allocations that do not add up to the quantity', () => reject(sell('S', '2025-01-01', '40', '30', '0', [['A', '15'], ['B', '20']]), [], /add up to 35/));
    it('a lot named twice', () => reject(sell('S', '2025-01-01', '40', '30', '0', [['A', '20'], ['A', '20']]), [], /more than once/));
    it('zero or negative quantities', () => {
      reject(sell('S', '2025-01-01', '40', '30', '0', [['A', '40'], ['B', '0']]), [], /greater than zero/);
      reject(sell('S', '2025-01-01', '40', '30', '0', [['A', '50'], ['B', '-10']]), [], /greater than zero/);
    });
    it('an unknown lot, e.g. one from another account or user', () => reject(sell('S', '2025-01-01', '10', '30', '0', [['someone-elses', '10']]), [], /not a purchase of VOO in this account/));
    it('a lot of another ticker', () => reject(sell('S', '2025-01-01', '5', '30', '0', [['X', '5']]), [], /purchase of TSLA/));
    it('a lot bought after the sale', () => reject(sell('S', '2024-03-01', '10', '30', '0', [['B', '10']]), [], /bought on 2024-06-10, after this sale/));
    it('taking more than a lot has left', () => reject(sell('S', '2025-01-01', '101', '30', '0', [['A', '101']]), [], /only 100 shares left/));
    it('taking from a lot that an earlier sale already consumed', () =>
      reject(sell('S2', '2025-02-01', '10', '30', '0', [['A', '10']]), [sell('S1', '2025-01-01', '95', '30', '0', [['A', '95']])], /only 5 shares left/));
    it('a backdated FIFO sale that consumes a lot a later explicit sale relies on', () =>
      reject(sell('S2', '2025-02-01', '100', '30', '0', [['A', '100']]), [sell('S1', '2024-12-01', '10', '30')], /only 90 shares left/));
  });

  it('keeps historical lots per date in valuation replays', () => {
    const entries = [
      deposit('2024-01-01', '100000'),
      buy('A', '2024-01-10', '100', '10'),
      buy('B', '2024-06-10', '200', '20'),
      sell('S', '2025-03-01', '40', '30', '0', [['A', '15'], ['B', '25']]),
    ];
    const byDate = positionsByDate(entries, ['2025-02-28', '2025-03-01']);
    const lots = (date: string) => byDate.get(date)![0].lots.map((l) => [l.lotId, fmt(l.remainingQuantity)]);
    expect(lots('2025-02-28')).toEqual([['A', '100'], ['B', '200']]);
    expect(lots('2025-03-01')).toEqual([['A', '85'], ['B', '175']]);
  });
});
