import { assetClassOf, byAmountDesc, percentOf, priceStatusOf, worstStatus, type TypedAccount } from './dashboard-math';

describe('dashboard maths', () => {
  const accounts: TypedAccount[] = [
    { id: 'super', parentAccountId: null, type: 'SUPERANNUATION' },
    { id: 'super-shares', parentAccountId: 'super', type: 'INVESTMENT' },
    { id: 'super-deep', parentAccountId: 'super-shares', type: 'CASH' },
    { id: 'broker', parentAccountId: null, type: 'INVESTMENT' },
    { id: 'bank', parentAccountId: null, type: 'CASH' },
  ];
  const byId = new Map(accounts.map((a) => [a.id, a]));

  it('classes everything under a super account as super, then holdings as shares and cash as cash', () => {
    expect(assetClassOf({ accountId: 'super', kind: 'cash' }, byId)).toBe('super');
    expect(assetClassOf({ accountId: 'super-shares', kind: 'holding' }, byId)).toBe('super');
    expect(assetClassOf({ accountId: 'super-deep', kind: 'cash' }, byId)).toBe('super');
    expect(assetClassOf({ accountId: 'broker', kind: 'holding' }, byId)).toBe('shares');
    expect(assetClassOf({ accountId: 'broker', kind: 'cash' }, byId)).toBe('cash');
    expect(assetClassOf({ accountId: 'bank', kind: 'cash' }, byId)).toBe('cash');
  });

  it('gives percentages to 2 dp, and null when a figure is unknown or the whole is zero', () => {
    expect(percentOf('1', '3')).toBe('33.33');
    expect(percentOf('2', '3')).toBe('66.67');
    expect(percentOf('0', '10')).toBe('0');
    expect(percentOf('5', '0')).toBeNull();
    expect(percentOf(null, '10')).toBeNull();
    expect(percentOf('5', null)).toBeNull();
  });

  it('rates price quality: cost fallback, mock, stale, market', () => {
    const now = new Date('2026-10-22T00:00:00Z');
    const price = (asOf: string, isMock = false) => ({ price: '1', asOf, source: 'yahoo', isMock });
    expect(priceStatusOf({ basis: 'cost', price: null }, now)).toBe('COST_FALLBACK');
    expect(priceStatusOf({ basis: 'market', price: price('2026-10-21T00:00:00Z', true) }, now)).toBe('MOCK');
    expect(priceStatusOf({ basis: 'market', price: price('2026-10-10T00:00:00Z') }, now)).toBe('STALE');
    expect(priceStatusOf({ basis: 'market', price: price('2026-10-18T00:00:00Z') }, now)).toBe('MARKET');
    expect(worstStatus(['MARKET', 'STALE', 'MOCK'])).toBe('STALE');
    expect(worstStatus([])).toBe('MARKET');
  });

  it('sorts largest first with unknown amounts last', () => {
    const rows = [
      { n: 'a', v: '10' },
      { n: 'b', v: null },
      { n: 'c', v: '100.5' },
      { n: 'd', v: '10' },
    ];
    expect([...rows].sort(byAmountDesc((r) => r.v, (r) => r.n)).map((r) => r.n)).toEqual(['c', 'a', 'd', 'b']);
  });
});
