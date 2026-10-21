import { dec } from '../common/decimal';
import { ValidationError } from '../common/errors';
import {
  assertRatesCover,
  buildAccountTree,
  effectiveItemCategory,
  holdingKey,
  partitionByCategory,
  totalsOf,
  type ValuationItem,
} from './aggregation';

const accounts = [
  { id: 'up', name: 'Up!', parentAccountId: null, categoryId: null },
  { id: 'ef', name: 'Emergency Fund', parentAccountId: 'up', categoryId: 'emergency' },
  { id: 'td1', name: 'Term Deposit 1', parentAccountId: 'up', categoryId: null },
  { id: 'td1a', name: 'Rollover', parentAccountId: 'td1', categoryId: null },
  { id: 'stake', name: 'Stake', parentAccountId: null, categoryId: 'boring-etf' },
];
const byId = new Map(accounts.map((a) => [a.id, a]));

const cash = (accountId: string, currency: string, value: string): ValuationItem => ({
  accountId, kind: 'cash', symbol: null, currency, value: dec(value), basis: 'cash',
});
const holding = (accountId: string, symbol: string, currency: string, value: string): ValuationItem => ({
  accountId, kind: 'holding', symbol, currency, value: dec(value), quantity: dec(1), costBase: dec(value), basis: 'cost',
});

const items = [
  cash('up', 'AUD', '100'),
  cash('ef', 'AUD', '10000'),
  cash('td1', 'AUD', '5000'),
  cash('td1a', 'AUD', '2500'),
  cash('stake', 'USD', '50'),
  holding('stake', 'TSLA', 'USD', '4000'),
  holding('stake', 'VOO', 'USD', '6000'),
];
const holdingCategories = new Map([[holdingKey('stake', 'TSLA'), 'alpha-high-risk']]);

describe('report aggregation', () => {
  it('totals per currency, never mixing currencies', () => {
    expect(totalsOf(items, null)).toEqual({
      byCurrency: [
        { currency: 'AUD', cash: '17600', holdings: '0', total: '17600' },
        { currency: 'USD', cash: '50', holdings: '10000', total: '10050' },
      ],
      converted: null,
    });
  });

  it('converts with the caller\'s rates when given an FX policy', () => {
    const totals = totalsOf(items, { baseCurrency: 'AUD', rates: { USD: '1.5' } });
    expect(totals.converted).toEqual({ baseCurrency: 'AUD', cash: '17675', holdings: '15000', total: '32675' });
  });

  it('refuses a converted total when a rate is missing, naming the currency', () => {
    expect(() => assertRatesCover(items, { baseCurrency: 'AUD', rates: {} })).toThrow(ValidationError);
    try {
      assertRatesCover(items, { baseCurrency: 'EUR', rates: { USD: '0.9' } });
    } catch (error) {
      expect((error as ValidationError).details).toEqual({ missingRates: ['AUD'], baseCurrency: 'EUR' });
    }
    expect(() => assertRatesCover(items, { baseCurrency: 'AUD', rates: { USD: '1.5' } })).not.toThrow();
    expect(() => assertRatesCover(items, null)).not.toThrow();
  });

  describe('account tree', () => {
    const tree = buildAccountTree(accounts, items);
    const up = tree.find((n) => n.account.id === 'up')!;

    it('separates own from rolled-up figures', () => {
      expect(totalsOf(up.ownItems, null).byCurrency).toEqual([{ currency: 'AUD', cash: '100', holdings: '0', total: '100' }]);
      expect(totalsOf(up.rolledUpItems, null).byCurrency).toEqual([{ currency: 'AUD', cash: '17600', holdings: '0', total: '17600' }]);
      const td1 = up.children.find((n) => n.account.id === 'td1')!;
      expect(td1.level).toBe(2);
      expect(totalsOf(td1.rolledUpItems, null).byCurrency[0].total).toBe('7500');
    });

    it('counts each item once: top-level rolledUp figures add up to the grand total', () => {
      const topLevel = tree.flatMap((n) => n.rolledUpItems);
      expect(topLevel).toHaveLength(items.length);
      expect(new Set(topLevel)).toEqual(new Set(items));
      expect(totalsOf(topLevel, null)).toEqual(totalsOf(items, null));
    });

    it('builds a subtree from a given root, at its real level', () => {
      const [td1] = buildAccountTree(accounts, items, ['td1']);
      expect(td1.level).toBe(2);
      expect(td1.children.map((c) => c.account.id)).toEqual(['td1a']);
    });
  });

  describe('categories', () => {
    it('resolves holding → account → nearest ancestor → none', () => {
      expect(effectiveItemCategory({ accountId: 'stake', symbol: 'TSLA' }, byId, holdingCategories)).toEqual({
        categoryId: 'alpha-high-risk', source: 'holding', fromAccountId: null,
      });
      expect(effectiveItemCategory({ accountId: 'stake', symbol: 'VOO' }, byId, holdingCategories)).toEqual({
        categoryId: 'boring-etf', source: 'account', fromAccountId: 'stake',
      });
      expect(effectiveItemCategory({ accountId: 'td1a', symbol: null }, byId, holdingCategories).source).toBe('none');
      const nested = new Map(byId);
      nested.set('up', { ...accounts[0], categoryId: 'cash' });
      expect(effectiveItemCategory({ accountId: 'td1a', symbol: null }, nested, holdingCategories)).toEqual({
        categoryId: 'cash', source: 'ancestor', fromAccountId: 'up',
      });
    });

    it('puts every item in exactly one category, so category totals add up to the grand total', () => {
      const groups = partitionByCategory(items, byId, holdingCategories);
      expect([...groups.keys()].sort()).toEqual(['alpha-high-risk', 'boring-etf', 'emergency', null].sort());
      expect([...groups.values()].flat()).toHaveLength(items.length);
      expect(totalsOf(groups.get('alpha-high-risk')!, null).byCurrency).toEqual([{ currency: 'USD', cash: '0', holdings: '4000', total: '4000' }]);
      expect(totalsOf(groups.get('boring-etf')!, null).byCurrency).toEqual([{ currency: 'USD', cash: '50', holdings: '6000', total: '6050' }]);
      expect(totalsOf(groups.get(null)!, null).byCurrency[0].total).toBe('7600');
      const sum = [...groups.values()].reduce((acc, g) => acc.plus(dec(totalsOf(g, { baseCurrency: 'AUD', rates: { USD: '1.5' } }).converted!.total)), dec(0));
      expect(sum.toFixed()).toBe(totalsOf(items, { baseCurrency: 'AUD', rates: { USD: '1.5' } }).converted!.total);
    });
  });
});
