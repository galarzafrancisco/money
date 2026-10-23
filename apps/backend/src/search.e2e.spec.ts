import { createUpMock, type UpMock } from 'up-bank-mock';
import { callTool, createTestApp, type TestApp } from './test-support/test-app';

/** Merchant and account discovery over manual and Up-imported data (mock provider) */
describe('merchant and account search', () => {
  let t: TestApp;
  let up: UpMock;
  let tokenA: string;
  let tokenB: string;
  let mcpA: string;
  let n = 0;
  let spending: any;
  let savings: any;

  const as = (token: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: unknown) => t.http.post(url).set('Authorization', `Bearer ${token}`).send((body ?? {}) as object),
    put: (url: string, body: unknown) => t.http.put(url).set('Authorization', `Bearer ${token}`).send(body as object),
  });
  const merchants = async (token: string, query: string, expected = 200) => (await as(token).get(`/api/search/merchants?${query}`).expect(expected)).body;
  const accounts = async (token: string, query = '') => (await as(token).get(`/api/search/accounts?${query}`).expect(200)).body;

  beforeAll(async () => {
    up = createUpMock({});
    const baseUrl = await up.listen();
    t = await createTestApp({ env: { UP_API_BASE_URL: baseUrl, UP_REGISTER_WEBHOOK: 'false', UP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), UP_PAGE_SIZE: '50' } });
    tokenA = await t.token({ subject: 'search-a' });
    tokenB = await t.token({ subject: 'search-b' });
    mcpA = await t.token({ subject: 'search-a', audience: 'http://money.test/mcp' });

    const tokenUp = `up:user:search-token-${++n}-abcdefgh`;
    const { accountIds } = up.addCustomer(tokenUp);
    const buy = (accountId: string, description: string, amountInBaseUnits = -1000) => up.addTransaction(tokenUp, { accountId, description, amountInBaseUnits, emit: false });
    const first = accountIds[0];
    for (const d of ['BBQs In The Hills', 'BBQs In The Hills', 'Barbeques Galore', 'BARBEQUES GALORE 4411', 'Barbeques Galore Pty Ltd', 'Guzman y Gomez', 'GUZMAN Y GOMEZ', 'Woolworths']) buy(first, d);
    // A transfer sharing a merchant's description must never surface through that merchant's key
    up.addTransaction(tokenUp, { accountId: first, description: 'Barbeques Galore', amountInBaseUnits: -5000, transferAccountId: accountIds[1], emit: false });
    await as(tokenA).post('/api/up/connection', { token: tokenUp }).expect(201);
    const all = (await as(tokenA).get('/api/up/accounts?visibility=all').expect(200)).body as any[];
    spending = all.find((a) => a.upId === first);
    savings = all.find((a) => a.upId !== first);
    // Only the first account is hidden; make `savings` visible so both states exist
    await as(tokenA).put('/api/up/accounts/visibility', { visibleAccountIds: [savings.id] }).expect(200);
  });
  afterAll(async () => {
    await up.close();
    await t.close();
  });

  describe('merchants', () => {
    it('does not search hidden accounts by default, but does with visibility=all or accountId', async () => {
      expect((await merchants(tokenA, 'q=guzman')).items).toEqual([]);
      const all = await merchants(tokenA, 'q=guzman&visibility=all');
      expect(all.items).toHaveLength(1);
      expect((await merchants(tokenA, `q=guzman&accountId=${spending.id}`)).items).toHaveLength(1);
    });

    it('matches partial names case-insensitively and folds spellings into one merchant', async () => {
      const { items } = await merchants(tokenA, 'q=GUZMAN&visibility=all');
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ merchantKey: 'up:guzman-y-gomez', transactionCount: 2, source: 'up', matchType: 'prefix' });
      expect(items[0].aliases).toHaveLength(1);
      const galore = await merchants(tokenA, 'q=galore&visibility=all');
      expect(galore.items).toHaveLength(1);
      expect(galore.items[0]).toMatchObject({ merchantKey: 'up:barbeques-galore', transactionCount: 3 });
    });

    it('keeps BBQ retailers apart and never labels a different one as exact', async () => {
      const bbq = (await merchants(tokenA, 'q=BBQ&visibility=all')).items;
      expect(bbq.map((m: any) => m.merchantKey).sort()).toEqual(['up:barbeques-galore', 'up:bbqs-in-the-hills']);
      const galore = (await merchants(tokenA, 'q=BBQ%20Galore&visibility=all')).items;
      expect(galore.map((m: any) => m.merchantKey)).toEqual(['up:barbeques-galore']);
      expect(galore[0].matchType).toBe('alias');
      expect(galore[0].matchType).not.toBe('exact');
      expect((await merchants(tokenA, 'q=Barbeques%20Galore&visibility=all')).items[0].matchType).toBe('exact');
    });

    it('returns nothing for non-matches and rejects an empty query', async () => {
      expect((await merchants(tokenA, 'q=zzzqqq&visibility=all')).items).toEqual([]);
      await merchants(tokenA, 'visibility=all', 400);
    });

    it('feeds a merchantKey into transaction search', async () => {
      const key = 'up:barbeques-galore';
      const page = (await as(tokenA).get(`/api/up/transactions?visibility=all&merchantKey=${key}`).expect(200)).body;
      expect(page.items).toHaveLength(3);
      expect(page.items.every((x: any) => /galore/i.test(x.description) && x.transferUpAccountId == null)).toBe(true);
      expect((await as(tokenA).get('/api/up/transactions?visibility=all&merchantKey=up:nobody').expect(200)).body.items).toEqual([]);
      await as(tokenA).get('/api/up/transactions?merchantKey=not-a-key').expect(400);
    });

    it('is deterministic and paginates', async () => {
      const first = await merchants(tokenA, 'q=b&visibility=all&limit=1');
      expect(first.items).toHaveLength(1);
      expect(first.nextOffset).toBe(1);
      const again = await merchants(tokenA, 'q=b&visibility=all&limit=1');
      expect(again).toEqual(first);
      const rest = await merchants(tokenA, `q=b&visibility=all&limit=100&offset=${first.nextOffset}`);
      expect(rest.items.map((m: any) => m.merchantKey)).not.toContain(first.items[0].merchantKey);
      await merchants(tokenA, 'q=b&limit=1000', 400);
    });

    it("never reveals another user's merchants", async () => {
      expect((await merchants(tokenB, 'q=guzman&visibility=all')).items).toEqual([]);
      await merchants(tokenB, `q=guzman&accountId=${spending.id}`, 404);
    });
  });

  describe('accounts', () => {
    beforeAll(async () => {
      for (const name of ['Holiday Fund', 'Holiday Fund 2', 'Spending']) {
        await as(tokenA).post('/api/accounts', { name, type: 'CASH', reportingCurrency: 'AUD' }).expect(201);
      }
    });

    it('covers manual and imported accounts, keeps similar names distinct, and is case-insensitive', async () => {
      const holiday = (await accounts(tokenA, 'q=holiday')).items;
      expect(holiday.map((a: any) => a.name)).toEqual(['Holiday Fund', 'Holiday Fund 2']);
      expect(new Set(holiday.map((a: any) => a.id)).size).toBe(2);
      expect(holiday[0]).toMatchObject({ source: 'manual', visible: true, currency: 'AUD', type: 'CASH', matchType: 'prefix' });
      const spend = (await accounts(tokenA, 'q=SPENDING&visibility=all')).items;
      expect(spend.filter((a: any) => a.name === 'Spending').map((a: any) => a.source).sort()).toEqual(['manual', 'up']);
      expect(spend[0].matchType).toBe('exact'); // exact names rank first
    });

    it('hides hidden Up accounts by default and shows them when asked', async () => {
      const upOnly = (query: string) => accounts(tokenA, `source=up&${query}`).then((r) => r.items.map((a: any) => a.id));
      expect(await upOnly('')).toEqual([savings.id]);
      expect(await upOnly('visibility=hidden')).toEqual(expect.arrayContaining([spending.id]));
      expect(await upOnly('visibility=all')).toHaveLength(3);
    });

    it('leaks no tokens or raw provider data and nothing of other users', async () => {
      const json = JSON.stringify((await accounts(tokenA, 'visibility=all')).items);
      expect(json).not.toMatch(/ciphertext|search-token|upId|balance/i);
      expect((await accounts(tokenB, 'visibility=all')).items).toEqual([]);
    });

    it('paginates in deterministic order', async () => {
      const page1 = await accounts(tokenA, 'visibility=all&limit=2');
      expect(page1.items).toHaveLength(2);
      const page2 = await accounts(tokenA, `visibility=all&limit=2&offset=${page1.nextOffset}`);
      const names = [...page1.items, ...page2.items].map((a: any) => a.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });
  });

  describe('large datasets', () => {
    it('answers from aggregates over thousands of transactions', async () => {
      const token = `up:user:search-token-${++n}-abcdefgh`;
      const { accountIds } = up.addCustomer(token);
      for (let i = 0; i < 3000; i++) up.addTransaction(token, { accountId: accountIds[0], description: `Shop${i % 40}x`, amountInBaseUnits: -100, emit: false });
      const big = await t.token({ subject: 'search-big' });
      await as(big).post('/api/up/connection', { token }).expect(201);
      const started = Date.now();
      const result = await merchants(big, 'q=shop&visibility=all&limit=100');
      const mine = result.items.filter((m: any) => /^Shop\d+x$/.test(m.name));
      expect(mine).toHaveLength(40);
      expect(mine.every((m: any) => m.transactionCount === 75)).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
    }, 120_000);
  });

  describe('MCP', () => {
    it('exposes the same search, hidden accounts included by default', async () => {
      const found = await callTool(t, mcpA, 'search_merchants', { q: 'guzman' });
      expect(found.isError).toBe(false);
      expect(found.data.items[0]).toMatchObject({ merchantKey: 'up:guzman-y-gomez' });
      const narrowed = await callTool(t, mcpA, 'search_merchants', { q: 'guzman', visibility: 'visible' });
      expect(narrowed.data.items).toEqual([]);
      const accs = await callTool(t, mcpA, 'search_accounts', { q: 'spending' });
      expect(accs.data.items.filter((a: any) => a.name === 'Spending').map((a: any) => a.source).sort()).toEqual(['manual', 'up']);
      const txs = await callTool(t, mcpA, 'list_up_transactions', { merchantKey: 'up:guzman-y-gomez' });
      expect(txs.data.items).toHaveLength(2);
    });
  });
});
