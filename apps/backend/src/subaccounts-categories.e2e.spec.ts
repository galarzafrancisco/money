import { callTool, createTestApp, type TestApp } from './test-support/test-app';

describe('subaccounts, categories and reports', () => {
  let t: TestApp;
  let tokenA: string;
  let tokenB: string;
  let mcpA: string;
  let mcpB: string;

  beforeAll(async () => {
    t = await createTestApp();
    tokenA = await t.token({ subject: 'user-a' });
    tokenB = await t.token({ subject: 'user-b' });
    mcpA = await t.token({ subject: 'user-a', audience: t.config.auth.mcpResourceUrl });
    mcpB = await t.token({ subject: 'user-b', audience: t.config.auth.mcpResourceUrl });
    t.prices.setPrice('TSLA', '200');
    t.prices.setPrice('VOO', '500');
  });
  afterAll(() => t.close());

  const as = (token: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: unknown) => t.http.post(url).set('Authorization', `Bearer ${token}`).send(body as object),
    put: (url: string, body: unknown) => t.http.put(url).set('Authorization', `Bearer ${token}`).send(body as object),
    patch: (url: string, body: unknown) => t.http.patch(url).set('Authorization', `Bearer ${token}`).send(body as object),
    delete: (url: string) => t.http.delete(url).set('Authorization', `Bearer ${token}`),
  });
  const a = () => as(tokenA);
  const deposit = (accountId: string, amount: string, currency = 'AUD') =>
    a().post(`/api/accounts/${accountId}/transactions`, { type: 'DEPOSIT', date: '2025-01-01', currency, amount }).expect(201);

  describe('account hierarchy', () => {
    it('creates subaccounts, and allows the same name under different parents', async () => {
      const up = (await a().post('/api/accounts', { name: 'Hier Bank', type: 'CASH' }).expect(201)).body;
      expect(up).toMatchObject({ parentAccountId: null, categoryId: null });
      const td = (await a().post('/api/accounts', { name: 'Term Deposit 1', type: 'CASH', parentAccountId: up.id }).expect(201)).body;
      expect(td.parentAccountId).toBe(up.id);
      const other = (await a().post('/api/accounts', { name: 'Hier Bank 2' }).expect(201)).body;
      await a().post('/api/accounts', { name: 'term deposit 1', parentAccountId: other.id }).expect(201);
      const dup = await a().post('/api/accounts', { name: 'TERM DEPOSIT 1', parentAccountId: up.id }).expect(409);
      expect(dup.body.error.code).toBe('conflict');
    });

    it('refuses cycles, self-parenting and nesting deeper than 5 levels', async () => {
      const ids: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const body = { name: `Level ${i}`, parentAccountId: ids[ids.length - 1] };
        ids.push((await a().post('/api/accounts', body).expect(201)).body.id);
      }
      const tooDeep = await a().post('/api/accounts', { name: 'Level 6', parentAccountId: ids[4] }).expect(409);
      expect(tooDeep.body.error.details).toMatchObject({ maxDepth: 5 });

      const cycle = await a().patch(`/api/accounts/${ids[0]}`, { parentAccountId: ids[3] }).expect(409);
      expect(cycle.body.error.details).toEqual({ reason: 'cycle' });
      const self = await a().patch(`/api/accounts/${ids[2]}`, { parentAccountId: ids[2] }).expect(409);
      expect(self.body.error.details).toEqual({ reason: 'self' });

      // Moving level 4 (with level 5 below it) to the top is fine, and back under level 1 too
      await a().patch(`/api/accounts/${ids[3]}`, { parentAccountId: null }).expect(200);
      const moved = await a().patch(`/api/accounts/${ids[3]}`, { parentAccountId: ids[0] }).expect(200);
      expect(moved.body.parentAccountId).toBe(ids[0]);
      // A subtree three levels high cannot go under a level-3 account (3 + 3 = 6 levels)
      const outsider = (await a().post('/api/accounts', { name: 'Deep top' }).expect(201)).body;
      const deepChild = (await a().post('/api/accounts', { name: 'Deep child', parentAccountId: outsider.id }).expect(201)).body;
      await a().post('/api/accounts', { name: 'Deep grandchild', parentAccountId: deepChild.id }).expect(201);
      await a().patch(`/api/accounts/${outsider.id}`, { parentAccountId: ids[2] }).expect(409);
    });

    it('refuses deleting an account that has subaccounts', async () => {
      const parent = (await a().post('/api/accounts', { name: 'Has kids' }).expect(201)).body;
      const child = (await a().post('/api/accounts', { name: 'Kid', parentAccountId: parent.id }).expect(201)).body;
      const refused = await a().delete(`/api/accounts/${parent.id}`).expect(409);
      expect(refused.body.error.details).toEqual({ subaccountCount: 1 });
      await a().delete(`/api/accounts/${child.id}`).expect(200);
      await a().delete(`/api/accounts/${parent.id}`).expect(200);
    });

    it('serializes concurrent moves so they cannot create a cycle together', async () => {
      const x = (await a().post('/api/accounts', { name: 'Race X' }).expect(201)).body;
      const y = (await a().post('/api/accounts', { name: 'Race Y' }).expect(201)).body;
      const results = await Promise.all([
        a().patch(`/api/accounts/${x.id}`, { parentAccountId: y.id }),
        a().patch(`/api/accounts/${y.id}`, { parentAccountId: x.id }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });
  });

  describe('categories', () => {
    it('creates, renames and lists categories with case-insensitive unique names', async () => {
      const created = (await a().post('/api/categories', { name: 'Speculative', color: '#FF0000', description: 'fun money' }).expect(201)).body;
      expect(created).toMatchObject({ name: 'Speculative', color: '#ff0000', description: 'fun money' });
      await a().post('/api/categories', { name: 'speculative' }).expect(409);
      await a().post('/api/categories', { name: 'Bad colour', color: 'red' }).expect(400);
      const renamed = await a().patch(`/api/categories/${created.id}`, { name: 'Moonshots', color: null }).expect(200);
      expect(renamed.body).toMatchObject({ name: 'Moonshots', color: null });
      const list = await a().get('/api/categories').expect(200);
      expect(list.body.map((c: { name: string }) => c.name)).toContain('Moonshots');
    });

    it('requires unassign=true to delete an assigned category, then falls back to inheritance', async () => {
      const cat = (await a().post('/api/categories', { name: 'Temp cat' }).expect(201)).body;
      const account = (await a().post('/api/accounts', { name: 'Temp cat account', categoryId: cat.id }).expect(201)).body;
      expect(account.categoryId).toBe(cat.id);
      await a().put(`/api/accounts/${account.id}/holdings/abc/category`, { categoryId: cat.id }).expect(200, { accountId: account.id, symbol: 'ABC', categoryId: cat.id });
      const usage = await a().get(`/api/categories/${cat.id}`).expect(200);
      expect(usage.body.usage).toEqual({ accounts: 1, holdings: 1 });

      const refused = await a().delete(`/api/categories/${cat.id}`).expect(409);
      expect(refused.body.error.details).toEqual({ accounts: 1, holdings: 1 });
      await a().delete(`/api/categories/${cat.id}?unassign=true`).expect(200, { deleted: true, unassigned: { accounts: 1, holdings: 1 } });
      expect((await a().get(`/api/accounts/${account.id}`).expect(200)).body.categoryId).toBeNull();
      expect((await a().get(`/api/holding-categories?accountId=${account.id}`).expect(200)).body).toEqual([]);
    });

    it('clears a holding category', async () => {
      const cat = (await a().post('/api/categories', { name: 'Clearable' }).expect(201)).body;
      const account = (await a().post('/api/accounts', { name: 'Clear account' }).expect(201)).body;
      await a().put(`/api/accounts/${account.id}/holdings/VOO/category`, { categoryId: cat.id }).expect(200);
      await a().delete(`/api/accounts/${account.id}/holdings/VOO/category`).expect(200, { accountId: account.id, symbol: 'VOO', categoryId: null });
      await a().put(`/api/accounts/${account.id}/holdings/VOO/category`, {}).expect(400);
    });
  });

  describe('reports', () => {
    let up: string;
    let emergency: string;
    let td1: string;
    let stake: string;
    let alpha: string;
    let boring: string;
    let emergencyCat: string;
    let tokenR: string;
    const r = () => as(tokenR);

    beforeAll(async () => {
      // A separate user, so the other tests' accounts do not appear
      tokenR = await t.token({ subject: 'reporter' });
      const post = (url: string, body: unknown) => r().post(url, body).expect(201).then((res) => res.body);
      alpha = (await post('/api/categories', { name: 'alpha-high-risk' })).id;
      boring = (await post('/api/categories', { name: 'boring-etf' })).id;
      emergencyCat = (await post('/api/categories', { name: 'emergency' })).id;
      up = (await post('/api/accounts', { name: 'Up!', type: 'CASH' })).id;
      emergency = (await post('/api/accounts', { name: 'Emergency Fund', type: 'CASH', parentAccountId: up, categoryId: emergencyCat })).id;
      td1 = (await post('/api/accounts', { name: 'Term Deposit 1', type: 'CASH', parentAccountId: up })).id;
      stake = (await post('/api/accounts', { name: 'Stake', categoryId: boring })).id;

      const tx = (accountId: string, body: object) => post(`/api/accounts/${accountId}/transactions`, { date: '2025-01-01', ...body });
      await tx(up, { type: 'DEPOSIT', currency: 'AUD', amount: '100' });
      await tx(emergency, { type: 'DEPOSIT', currency: 'AUD', amount: '10000' });
      await tx(td1, { type: 'DEPOSIT', currency: 'AUD', amount: '5000' });
      await tx(stake, { type: 'DEPOSIT', currency: 'USD', amount: '10000' });
      await tx(stake, { type: 'BUY', symbol: 'TSLA', currency: 'USD', quantity: '10', unitPrice: '150', fees: '0' });
      await tx(stake, { type: 'BUY', symbol: 'VOO', currency: 'USD', quantity: '10', unitPrice: '400', fees: '0' });
      await r().put(`/api/accounts/${stake}/holdings/TSLA/category`, { categoryId: alpha }).expect(200);
    });

    it('gives the account tree with own and rolled-up figures, counting everything once', async () => {
      const { body } = await r().get('/api/reports/accounts').expect(200);
      expect(body.accounts.map((n: { name: string }) => n.name)).toEqual(['Stake', 'Up!']);
      const upNode = body.accounts.find((n: { id: string }) => n.id === up);
      expect(upNode.own.byCurrency).toEqual([{ currency: 'AUD', cash: '100', holdings: '0', total: '100' }]);
      expect(upNode.rolledUp.byCurrency).toEqual([{ currency: 'AUD', cash: '15100', holdings: '0', total: '15100' }]);
      expect(upNode.children.map((c: { name: string; level: number }) => [c.name, c.level])).toEqual([
        ['Emergency Fund', 2],
        ['Term Deposit 1', 2],
      ]);
      const stakeNode = body.accounts.find((n: { id: string }) => n.id === stake);
      // Cash 10000 − 1500 − 4000 = 4500; TSLA 10 × 200; VOO 10 × 500
      expect(stakeNode.own.byCurrency).toEqual([{ currency: 'USD', cash: '4500', holdings: '7000', total: '11500' }]);
      expect(body.totals.byCurrency).toEqual([
        { currency: 'AUD', cash: '15100', holdings: '0', total: '15100' },
        { currency: 'USD', cash: '4500', holdings: '7000', total: '11500' },
      ]);
      expect(body.totals.converted).toBeNull();
      expect(body.warnings.join(' ')).toMatch(/mock/);
    });

    it('converts totals only with an explicit FX policy, and fails on a missing rate', async () => {
      const { body } = await r().get('/api/reports/accounts?baseCurrency=AUD&fxRates=USD:1.5').expect(200);
      expect(body.fx).toEqual({ baseCurrency: 'AUD', rates: { USD: '1.5' } });
      expect(body.totals.converted).toEqual({ baseCurrency: 'AUD', cash: '21850', holdings: '10500', total: '32350' });
      const missing = await r().get('/api/reports/accounts?baseCurrency=AUD').expect(400);
      expect(missing.body.error.details).toEqual({ missingRates: ['USD'], baseCurrency: 'AUD' });
      await r().get('/api/reports/accounts?fxRates=USD:1.5').expect(400);
      await r().get('/api/reports/accounts?baseCurrency=AUD&fxRates=USD:-1').expect(400);
    });

    it('values at cost base on request, and falls back to cost with a warning when a price is unusable', async () => {
      const cost = (await r().get('/api/reports/accounts?valuation=cost').expect(200)).body;
      expect(cost.totals.byCurrency[1]).toEqual({ currency: 'USD', cash: '4500', holdings: '5500', total: '10000' });
      t.prices.setPrice('TSLA', '200', 'EUR');
      try {
        const market = (await r().get('/api/reports/accounts').expect(200)).body;
        expect(market.totals.byCurrency[1].holdings).toBe('6500'); // TSLA at cost 1500 + VOO 5000
        expect(market.warnings.join(' ')).toMatch(/TSLA in "Stake" is valued at cost base/);
      } finally {
        t.prices.setPrice('TSLA', '200');
      }
    });

    it('limits the report to a subtree', async () => {
      const { body } = await r().get(`/api/reports/accounts?rootAccountId=${up}`).expect(200);
      expect(body.accounts).toHaveLength(1);
      expect(body.accounts[0].id).toBe(up);
      expect(body.totals.byCurrency).toEqual([{ currency: 'AUD', cash: '15100', holdings: '0', total: '15100' }]);
    });

    it('partitions balances by effective category, adding up to the total', async () => {
      const { body } = await r().get('/api/reports/categories?baseCurrency=AUD&fxRates=USD:1.5').expect(200);
      const byName = Object.fromEntries(body.categories.map((c: { category: { name: string } | null }) => [c.category?.name ?? 'Uncategorized', c]));
      expect(Object.keys(byName).sort()).toEqual(['Uncategorized', 'alpha-high-risk', 'boring-etf', 'emergency']);
      expect(byName['alpha-high-risk'].totals.byCurrency).toEqual([{ currency: 'USD', cash: '0', holdings: '2000', total: '2000' }]);
      expect(byName['alpha-high-risk'].items[0]).toMatchObject({ symbol: 'TSLA', categorySource: 'holding', accountPath: ['Stake'] });
      expect(byName['boring-etf'].totals.byCurrency).toEqual([{ currency: 'USD', cash: '4500', holdings: '5000', total: '9500' }]);
      expect(byName['emergency'].totals.byCurrency).toEqual([{ currency: 'AUD', cash: '10000', holdings: '0', total: '10000' }]);
      expect(byName['emergency'].items[0].accountPath).toEqual(['Up!', 'Emergency Fund']);
      expect(byName['Uncategorized'].totals.byCurrency).toEqual([{ currency: 'AUD', cash: '5100', holdings: '0', total: '5100' }]);

      const sum = body.categories.reduce((acc: number, c: { totals: { converted: { total: string } } }) => acc + Number(c.totals.converted.total), 0);
      expect(String(sum)).toBe(body.totals.converted.total);
    });

    it('lets subaccounts inherit the nearest ancestor\'s category, and reclassifies on change', async () => {
      await r().patch(`/api/accounts/${up}`, { categoryId: emergencyCat }).expect(200);
      const { body } = await r().get('/api/reports/categories').expect(200);
      const emergencyGroup = body.categories.find((c: { category: { id: string } | null }) => c.category?.id === emergencyCat);
      expect(emergencyGroup.totals.byCurrency[0].total).toBe('15100');
      const td = emergencyGroup.items.find((i: { accountId: string }) => i.accountId === td1);
      expect(td.categorySource).toBe('ancestor');
      await r().patch(`/api/accounts/${up}`, { categoryId: null }).expect(200);
    });

    it('serves the same reports over MCP', async () => {
      const mcpR = await t.token({ subject: 'reporter', audience: t.config.auth.mcpResourceUrl });
      const report = await callTool(t, mcpR, 'get_categories_report', { baseCurrency: 'aud', fxRates: { USD: '1.5' } });
      expect(report.isError).toBe(false);
      expect(report.data.totals.converted.total).toBe('32350');
      const tree = await callTool(t, mcpR, 'get_accounts_report', { rootAccountId: up });
      expect(tree.data.accounts[0].rolledUp.byCurrency[0].total).toBe('15100');
      const missing = await callTool(t, mcpR, 'get_accounts_report', { baseCurrency: 'EUR' });
      expect(missing.isError).toBe(true);
      expect(missing.data.error.code).toBe('validation_failed');
    });
  });

  describe('MCP management', () => {
    it('manages categories, subaccounts and holding categories', async () => {
      const cat = (await callTool(t, mcpA, 'create_category', { name: 'mcp-cat' })).data;
      expect(cat.name).toBe('mcp-cat');
      const parent = (await callTool(t, mcpA, 'create_account', { name: 'MCP parent' })).data;
      const child = (await callTool(t, mcpA, 'create_account', { name: 'MCP bucket', parentAccountId: parent.id, categoryId: cat.id })).data;
      expect(child).toMatchObject({ parentAccountId: parent.id, categoryId: cat.id });
      const set = await callTool(t, mcpA, 'set_holding_category', { accountId: parent.id, symbol: 'tsla', categoryId: cat.id });
      expect(set.data).toEqual({ accountId: parent.id, symbol: 'TSLA', categoryId: cat.id });
      const listed = (await callTool(t, mcpA, 'list_holding_categories', { accountId: parent.id })).data;
      expect(listed).toHaveLength(1);
      const refused = await callTool(t, mcpA, 'delete_account', { accountId: parent.id });
      expect(refused.data.error).toMatchObject({ code: 'conflict', details: { subaccountCount: 1 } });
      const del = await callTool(t, mcpA, 'delete_category', { categoryId: cat.id });
      expect(del.data.error.code).toBe('conflict');
      expect((await callTool(t, mcpA, 'delete_category', { categoryId: cat.id, unassign: true })).data.deleted).toBe(true);
    });
  });

  describe('isolation between users', () => {
    let accountA: string;
    let categoryA: string;

    beforeAll(async () => {
      accountA = (await a().post('/api/accounts', { name: 'Iso A' }).expect(201)).body.id;
      categoryA = (await a().post('/api/categories', { name: 'iso-cat' }).expect(201)).body.id;
      await deposit(accountA, '777');
    });

    it("refuses to reference another user's account or category over REST", async () => {
      const b = as(tokenB);
      const ownB = (await b.post('/api/accounts', { name: 'Iso B' }).expect(201)).body.id;
      const catB = (await b.post('/api/categories', { name: 'iso-cat' }).expect(201)).body.id;

      await b.post('/api/accounts', { name: 'Sneaky', parentAccountId: accountA }).expect(404);
      await b.post('/api/accounts', { name: 'Sneaky', categoryId: categoryA }).expect(404);
      await b.patch(`/api/accounts/${ownB}`, { parentAccountId: accountA }).expect(404);
      await b.patch(`/api/accounts/${ownB}`, { categoryId: categoryA }).expect(404);
      await b.put(`/api/accounts/${ownB}/holdings/VOO/category`, { categoryId: categoryA }).expect(404);
      await b.put(`/api/accounts/${accountA}/holdings/VOO/category`, { categoryId: catB }).expect(404);
      await b.delete(`/api/accounts/${accountA}/holdings/VOO/category`).expect(404);
      await b.get(`/api/categories/${categoryA}`).expect(404);
      await b.patch(`/api/categories/${categoryA}`, { name: 'mine' }).expect(404);
      await b.delete(`/api/categories/${categoryA}?unassign=true`).expect(404);
      await b.get(`/api/holding-categories?accountId=${accountA}`).expect(404);
      await b.get(`/api/reports/accounts?rootAccountId=${accountA}`).expect(404);
      await b.get(`/api/reports/categories?rootAccountId=${accountA}`).expect(404);
      // Moving A's account under B's is also refused: A's account is invisible to B
      await a().patch(`/api/accounts/${accountA}`, { parentAccountId: ownB }).expect(404);
    });

    it("never includes another user's money in reports or category lists", async () => {
      const b = as(tokenB);
      const report = (await b.get('/api/reports/accounts').expect(200)).body;
      expect(JSON.stringify(report)).not.toContain(accountA);
      expect(JSON.stringify(report)).not.toContain('777');
      const categories = (await b.get('/api/reports/categories').expect(200)).body;
      expect(JSON.stringify(categories)).not.toContain(categoryA);
      const list = (await b.get('/api/categories').expect(200)).body;
      expect(list.map((c: { id: string }) => c.id)).not.toContain(categoryA);
    });

    it.each([
      ['get_category', () => ({ categoryId: categoryA })],
      ['update_category', () => ({ categoryId: categoryA, name: 'mine' })],
      ['delete_category', () => ({ categoryId: categoryA, unassign: true })],
      ['set_holding_category', () => ({ accountId: accountA, symbol: 'VOO', categoryId: null })],
      ['list_holding_categories', () => ({ accountId: accountA })],
      ['get_accounts_report', () => ({ rootAccountId: accountA })],
      ['get_categories_report', () => ({ rootAccountId: accountA })],
      ['create_account', () => ({ name: 'Sneaky MCP', parentAccountId: accountA })],
      ['create_account', () => ({ name: 'Sneaky MCP 2', categoryId: categoryA })],
    ])("answers not_found to %s on another user's data over MCP", async (tool, args) => {
      const result = await callTool(t, mcpB, tool, args());
      expect(result.isError).toBe(true);
      expect(result.data.error).toMatchObject({ code: 'not_found' });
    });

    it("leaves the owner's data untouched", async () => {
      expect((await a().get(`/api/categories/${categoryA}`).expect(200)).body.name).toBe('iso-cat');
      expect((await a().get(`/api/accounts/${accountA}`).expect(200)).body.parentAccountId).toBeNull();
      const mine = (await callTool(t, mcpA, 'list_categories')).data;
      expect(mine.map((c: { id: string }) => c.id)).toContain(categoryA);
    });
  });
});
