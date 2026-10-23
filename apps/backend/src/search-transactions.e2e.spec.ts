import { createUpMock, type UpMock } from 'up-bank-mock';
import { callTool, createTestApp, type TestApp } from './test-support/test-app';

/** Server-side transaction search over imported Up data (mock provider) */
describe('transaction search', () => {
  let t: TestApp;
  let up: UpMock;
  let tokenA: string;
  let tokenB: string;
  let mcpA: string;
  let spending: any;
  let savings: any;
  // The mock also seeds recent transactions; every fixture row here is older
  const W = 'visibility=all&toDate=2025-12-31';

  const get = (token: string, query: string, expected = 200) => t.http.get(`/api/search/transactions?${query}`).set('Authorization', `Bearer ${token}`).expect(expected).then((r) => r.body);

  beforeAll(async () => {
    up = createUpMock({});
    const baseUrl = await up.listen();
    t = await createTestApp({ env: { UP_API_BASE_URL: baseUrl, UP_REGISTER_WEBHOOK: 'false', UP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), UP_PAGE_SIZE: '50' } });
    tokenA = await t.token({ subject: 'tsearch-a' });
    tokenB = await t.token({ subject: 'tsearch-b' });
    mcpA = await t.token({ subject: 'tsearch-a', audience: 'http://money.test/mcp' });

    const upToken = 'up:user:tsearch-token-abcdefgh';
    const { accountIds } = up.addCustomer(upToken);
    const add = (accountId: string, description: string, cents: number, createdAt: string, extra: object = {}) =>
      up.addTransaction(upToken, { accountId, description, amountInBaseUnits: cents, createdAt, emit: false, ...extra });
    const [a, b] = accountIds;
    add(a, 'Guzman y Gomez', -1250, '2022-03-10T02:00:00Z');
    add(a, 'GUZMAN Y GOMEZ 22', -1500, '2025-01-31T14:30:00Z'); // 2025-02-01 in Sydney
    add(a, 'Barbeques Galore', -25000, '2022-11-05T01:00:00Z');
    add(a, 'Barbeques Galore', 25000, '2022-11-20T01:00:00Z'); // refund
    add(a, 'Barbeques Galore', -9900, '2023-02-01T01:00:00Z', { status: 'HELD' });
    add(a, 'BBQs In The Hills', -15000, '2022-11-06T01:00:00Z');
    add(a, 'Barbeques Galore', -5000, '2023-03-01T01:00:00Z', { transferAccountId: b }); // transfer, not a purchase
    add(a, 'Hardware', -4000, '2023-04-01T01:00:00Z', { message: '50%_off voucher' });
    add(b, 'Guzman y Gomez', -900, '2024-06-01T01:00:00Z');
    add(b, 'Overseas Shop', -5000, '2024-06-02T01:00:00Z', { currencyCode: 'USD' });
    await t.http.post('/api/up/connection').set('Authorization', `Bearer ${tokenA}`).send({ token: upToken }).expect(201);
    const all = (await t.http.get('/api/up/accounts?visibility=all').set('Authorization', `Bearer ${tokenA}`).expect(200)).body as any[];
    spending = all.find((x) => x.upId === a);
    savings = all.find((x) => x.upId === b);
    await t.http.put('/api/up/accounts/visibility').set('Authorization', `Bearer ${tokenA}`).send({ visibleAccountIds: [savings.id] }).expect(200);
  });
  afterAll(async () => {
    await up.close();
    await t.close();
  });

  it('finds a merchant across accounts by key, newest first, with totals over all matches', async () => {
    const page = await get(tokenA, 'merchantKey=up:guzman-y-gomez&visibility=all');
    expect(page.items.map((i: any) => i.date)).toEqual(['2025-01-31T14:30:00.000Z', '2024-06-01T01:00:00.000Z', '2022-03-10T02:00:00.000Z']);
    expect(page.items[0]).toMatchObject({ merchant: 'GUZMAN Y GOMEZ 22', merchantKey: 'up:guzman-y-gomez', direction: 'out', amount: '-15', source: 'up', transfer: false });
    expect(page.summary).toMatchObject({ totalCount: 3, byCurrency: [{ currency: 'AUD', count: 3, moneyOut: '36.5', moneyIn: '0', net: '-36.5' }] });
    expect(page.matchedMerchants).toEqual([{ merchantKey: 'up:guzman-y-gomez', name: expect.any(String) }]);
    expect(page.nextOffset).toBeNull();
  });

  it('excludes hidden accounts by default but honours visibility and explicit accountIds', async () => {
    const key = 'merchantKey=up:guzman-y-gomez';
    expect((await get(tokenA, key)).summary.totalCount).toBe(1); // only the visible savings account
    expect((await get(tokenA, `${key}&visibility=hidden`)).summary.totalCount).toBe(2);
    expect((await get(tokenA, `${key}&accountIds=${spending.id}`)).summary.totalCount).toBe(2);
    expect((await get(tokenA, `${key}&visibility=all`)).summary.totalCount).toBe(3);
  });

  it('never mixes a different merchant in, and never returns transfers for a merchant', async () => {
    const galore = await get(tokenA, 'merchantKey=up:barbeques-galore&visibility=all');
    expect(galore.items).toHaveLength(3);
    expect(galore.items.every((i: any) => i.transfer === false && /galore/i.test(i.merchant))).toBe(true);
    const named = await get(tokenA, `merchant=${encodeURIComponent('BBQ Galore')}&visibility=all`);
    expect(named.matchedMerchants.map((m: any) => m.merchantKey)).toEqual(['up:barbeques-galore']);
  });

  it('applies absolute amount ranges inclusively with a required currency', async () => {
    const q = 'merchantKey=up:barbeques-galore&visibility=all&currency=AUD';
    expect((await get(tokenA, `${q}&minAmount=250&maxAmount=250`)).items.map((i: any) => i.amount).sort()).toEqual(['-250', '250']);
    expect((await get(tokenA, `${q}&minAmount=250&direction=out`)).items.map((i: any) => i.amount)).toEqual(['-250']);
    expect((await get(tokenA, `${q}&direction=in`)).summary.byCurrency[0]).toMatchObject({ moneyIn: '250', moneyOut: '0' });
    expect((await get(tokenA, `${q}&minAmount=250.01`)).items).toEqual([]);
    await get(tokenA, 'visibility=all&minAmount=10', 400);
    await get(tokenA, 'visibility=all&currency=AUD&minAmount=20&maxAmount=10', 400);
    await get(tokenA, 'visibility=all&currency=AUD&minAmount=-5', 400);
  });

  it('keeps currencies apart', async () => {
    const usd = await get(tokenA, 'visibility=all&currency=USD');
    expect(usd.items.map((i: any) => i.merchant)).toEqual(['Overseas Shop']);
    const both = await get(tokenA, W);
    expect(both.summary.byCurrency.map((c: any) => [c.currency, c.count, c.moneyOut])).toEqual([['AUD', 8, expect.any(String)], ['USD', 1, '50']]);
  });

  it('reads date bounds as local dates in the given timezone, inclusive, one-sided allowed', async () => {
    const base = 'merchantKey=up:guzman-y-gomez&visibility=all';
    expect((await get(tokenA, `${base}&fromDate=2025-02-01&timezone=Australia/Sydney`)).items).toHaveLength(1);
    expect((await get(tokenA, `${base}&fromDate=2025-02-01`)).items).toHaveLength(0); // UTC: it is still 31 January
    expect((await get(tokenA, `${base}&toDate=2025-01-31`)).items).toHaveLength(3);
    expect((await get(tokenA, `${base}&toDate=2025-01-30&timezone=Australia/Sydney`)).items).toHaveLength(2);
    expect((await get(tokenA, `${base}&fromDate=2022-03-10&toDate=2022-03-10`)).items).toHaveLength(1);
    await get(tokenA, `${base}&fromDate=2025-02-02&toDate=2025-02-01`, 400);
    await get(tokenA, `${base}&timezone=Not/AZone`, 400);
  });

  it('filters by status, free text and transfers without treating text as a merchant', async () => {
    expect((await get(tokenA, 'visibility=all&status=HELD')).items.map((i: any) => i.status)).toEqual(['HELD']);
    expect((await get(tokenA, 'visibility=all&text=50%25_off')).items.map((i: any) => i.merchant)).toEqual(['Hardware']); // % and _ are literal
    expect((await get(tokenA, 'visibility=all&text=%25')).summary.totalCount).toBe(1);
    expect((await get(tokenA, 'visibility=all&transfers=only')).items).toHaveLength(1);
    expect((await get(tokenA, `${W}`)).summary.totalCount).toBe(9);
    expect((await get(tokenA, `${W}&transfers=include`)).summary.totalCount).toBe(10);
  });

  it('paginates deterministically without truncating', async () => {
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: any = await get(tokenA, `${W}&transfers=include&limit=3&offset=${offset}`);
      expect(page.summary.totalCount).toBe(10);
      seen.push(...page.items.map((i: any) => i.id));
      offset = page.nextOffset;
    }
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
    await get(tokenA, 'limit=500', 400);
  });

  it('returns nothing for no match and rejects another user\'s or unknown accounts', async () => {
    const none = await get(tokenA, 'merchant=zzzqqq&visibility=all');
    expect(none).toMatchObject({ items: [], nextOffset: null, summary: { totalCount: 0, byCurrency: [] } });
    expect((await get(tokenB, 'visibility=all')).summary.totalCount).toBe(0);
    await get(tokenB, `accountIds=${spending.id}`, 404);
    await get(tokenA, 'accountIds=not-an-id', 404);
    await get(tokenA, 'merchantKey=up:guzman-y-gomez&merchant=guzman', 400);
  });

  it('searches one hidden account by explicit id', async () => {
    expect((await get(tokenA, `${W}&accountIds=${spending.id}`)).summary.totalCount).toBe(7);
    expect((await get(tokenA, `${W}&accountIds=${spending.id},${savings.id}`)).summary.totalCount).toBe(9);
  });

  it('is available over MCP, hidden accounts included by default', async () => {
    const r = await callTool(t, mcpA, 'search_transactions', { merchantKey: 'up:guzman-y-gomez', accountIds: [spending.id, savings.id], minAmount: '10', currency: 'AUD' });
    expect(r.isError).toBe(false);
    expect(r.data.items.map((i: any) => i.amount)).toEqual(['-15', '-12.5']);
    const bad = await callTool(t, mcpA, 'search_transactions', { minAmount: '10' });
    expect(bad.isError).toBe(true);
  });
});
