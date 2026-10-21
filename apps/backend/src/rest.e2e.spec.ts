import { createTestApp, type TestApp } from './test-support/test-app';

describe('REST API', () => {
  let t: TestApp;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    t = await createTestApp();
    tokenA = await t.token({ subject: 'user-a', claims: { displayName: 'Ada', email: 'ada@example.com' } });
    tokenB = await t.token({ subject: 'user-b' });
  });
  afterAll(() => t.close());

  const as = (token: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: unknown) => t.http.post(url).set('Authorization', `Bearer ${token}`).send(body as object),
    patch: (url: string, body: unknown) => t.http.patch(url).set('Authorization', `Bearer ${token}`).send(body as object),
    delete: (url: string) => t.http.delete(url).set('Authorization', `Bearer ${token}`),
  });

  describe('authentication', () => {
    it('serves health without a token', async () => {
      await t.http.get('/health').expect(200, { status: 'ok' });
    });

    it('refuses requests without a token, with a challenge pointing at the resource metadata', async () => {
      const response = await t.http.get('/api/accounts').expect(401);
      expect(response.headers['www-authenticate']).toContain('resource_metadata="http://money.test/.well-known/oauth-protected-resource/api"');
    });

    it('publishes protected resource metadata naming Taico', async () => {
      const response = await t.http.get('/.well-known/oauth-protected-resource/mcp').expect(200);
      expect(response.body).toMatchObject({ resource: 'http://money.test/mcp', authorization_servers: ['https://taico.test'] });
    });

    it.each([
      ['a token signed by an untrusted key', { foreignKey: true }],
      ['a token from another issuer', { issuer: 'https://evil.test' }],
      ['an expired token', { expiresInSeconds: -120 }],
      ['a token for another audience', { audience: 'https://other.test/api' }],
      ['an MCP token used on the REST API', { audience: 'http://money.test/mcp' }],
    ])('refuses %s', async (_label, options) => {
      const token = await t.token(options);
      await t.http.get('/api/accounts').set('Authorization', `Bearer ${token}`).expect(401);
    });

    it('maps the token to a user, ignoring any user ID in the request', async () => {
      const me = await as(tokenA).get('/api/me?userId=someone-else').expect(200);
      expect(me.body).toMatchObject({ issuer: 'https://taico.test', subject: 'user-a', displayName: 'Ada', email: 'ada@example.com' });
      const again = await as(tokenA).get('/api/me').expect(200);
      expect(again.body.id).toBe(me.body.id);
    });
  });

  describe('accounts', () => {
    it('creates, lists, renames and deletes accounts', async () => {
      const created = await as(tokenA).post('/api/accounts', { name: 'Scratch', reportingCurrency: 'usd' }).expect(201);
      expect(created.body).toMatchObject({ name: 'Scratch', type: 'INVESTMENT', reportingCurrency: 'USD' });
      const renamed = await as(tokenA).patch(`/api/accounts/${created.body.id}`, { name: 'Scratch 2', description: 'temp' }).expect(200);
      expect(renamed.body).toMatchObject({ name: 'Scratch 2', description: 'temp' });
      const list = await as(tokenA).get('/api/accounts').expect(200);
      expect(list.body.map((a: { name: string }) => a.name)).toContain('Scratch 2');
      await as(tokenA).delete(`/api/accounts/${created.body.id}`).expect(200, { deleted: true, transactionsDeleted: 0 });
      await as(tokenA).get(`/api/accounts/${created.body.id}`).expect(404);
    });

    it('rejects duplicate names per user, ignoring case, but allows the same name for another user', async () => {
      await as(tokenA).post('/api/accounts', { name: 'Dup' }).expect(201);
      const dup = await as(tokenA).post('/api/accounts', { name: 'dup' }).expect(409);
      expect(dup.body.error.code).toBe('conflict');
      await as(tokenB).post('/api/accounts', { name: 'Dup' }).expect(201);
    });

    it('validates input', async () => {
      const response = await as(tokenA).post('/api/accounts', { name: '', reportingCurrency: 'dollars' }).expect(400);
      expect(response.body.error.code).toBe('validation_failed');
    });

    it('requires explicit confirmation to delete an account with transactions', async () => {
      const account = (await as(tokenA).post('/api/accounts', { name: 'Has history' }).expect(201)).body;
      await as(tokenA).post(`/api/accounts/${account.id}/transactions`, { type: 'DEPOSIT', date: '2025-01-01', currency: 'AUD', amount: '10' }).expect(201);
      const refused = await as(tokenA).delete(`/api/accounts/${account.id}`).expect(409);
      expect(refused.body.error.details).toEqual({ transactionCount: 1 });
      await as(tokenA).delete(`/api/accounts/${account.id}?deleteTransactions=true`).expect(200, { deleted: true, transactionsDeleted: 1 });
    });
  });

  describe('an investment account end to end', () => {
    let accountId: string;
    const tx = (body: unknown) => as(tokenA).post(`/api/accounts/${accountId}/transactions`, body);

    beforeAll(async () => {
      accountId = (await as(tokenA).post('/api/accounts', { name: 'Stake' }).expect(201)).body.id;
    });

    it('records a deposit converted on the way, an FX conversion, buys, a sell and a dividend', async () => {
      const deposit = await tx({ type: 'DEPOSIT', date: '2024-01-02', currency: 'AUD', amount: '20000', description: 'From CommBank' }).expect(201);
      expect(deposit.body).toMatchObject({ type: 'DEPOSIT', currency: 'AUD', amount: '20000', sequence: 1 });

      await tx({ type: 'DEPOSIT', date: '2024-01-03', currency: 'USD', amount: '650', externalCurrency: 'AUD', externalAmount: '1000' }).expect(201);

      const conversion = await tx({ type: 'FX_CONVERSION', date: '2024-01-04', fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: '10000', rate: '0.655', fees: '6' }).expect(201);
      expect(conversion.body).toMatchObject({ toAmount: '6550', rate: '0.655', calculatedField: 'toAmount' });

      const buy = await tx({ type: 'BUY', date: '2024-01-10', symbol: 'voo', currency: 'USD', quantity: '10', unitPrice: '430', total: '4303' }).expect(201);
      expect(buy.body).toMatchObject({ symbol: 'VOO', fees: '3', calculatedField: 'fees' });

      const buy2 = await tx({ type: 'BUY', date: '2024-06-10', symbol: 'VOO', currency: 'USD', unitPrice: '480', fees: '3', total: '963' }).expect(201);
      expect(buy2.body).toMatchObject({ quantity: '2', calculatedField: 'quantity' });

      const sell = await tx({ type: 'SELL', date: '2025-01-11', symbol: 'VOO', currency: 'USD', quantity: '11', unitPrice: '500', fees: '3' }).expect(201);
      expect(sell.body).toMatchObject({ total: '5497', calculatedField: 'total' });

      const dividend = await tx({ type: 'DIVIDEND', date: '2025-03-28', symbol: 'VOO', currency: 'USD', grossAmount: '10', withholdingTax: '1.5' }).expect(201);
      expect(dividend.body).toMatchObject({ netAmount: '8.5', frankingCredits: '0' });

      await tx({ type: 'BUY', date: '2025-04-01', symbol: 'VAS.AX', currency: 'AUD', quantity: '20', unitPrice: '100', fees: '9.5' }).expect(201);
      await tx({ type: 'DIVIDEND', date: '2025-04-15', symbol: 'VAS.AX', currency: 'AUD', netAmount: '30', withholdingTax: '0', frankingCredits: '8' }).expect(201);
    });

    it('derives cash, holdings, lots, realized gains and dividends', async () => {
      t.prices.setPrice('VOO', '550', 'USD');
      t.prices.setPrice('VAS.AX', '110', 'AUD');
      const { body } = await as(tokenA).get(`/api/accounts/${accountId}/portfolio`).expect(200);

      // AUD: 20000 − 10000 − 6 − 2009.5 + 30 ; USD: 650 + 6550 − 4303 − 963 + 5497 + 8.5
      expect(body.cash).toEqual([
        { currency: 'AUD', balance: '8014.5' },
        { currency: 'USD', balance: '7439.5' },
      ]);

      const voo = body.holdings.find((h: { symbol: string }) => h.symbol === 'VOO');
      // 1 of the 2 shares from lot 2 remains: cost base 963 / 2
      expect(voo).toMatchObject({ quantity: '1', costBase: '481.5', marketValue: '550', unrealizedGain: '68.5' });
      expect(voo.price).toMatchObject({ source: 'mock', isMock: true });
      expect(voo.lots).toHaveLength(1);
      expect(voo.lots[0]).toMatchObject({ acquiredOn: '2024-06-10', originalQuantity: '2', remainingQuantity: '1', unitCostBase: '481.5' });

      const vas = body.holdings.find((h: { symbol: string }) => h.symbol === 'VAS.AX');
      expect(vas).toMatchObject({ currency: 'AUD', quantity: '20', costBase: '2009.5', marketValue: '2200', unrealizedGain: '190.5' });

      // Sold 11: 10 from lot 1 (4303) + 1 from lot 2 (481.5); proceeds 5497 split 10:1
      expect(body.realized.disposals).toHaveLength(2);
      expect(body.realized.disposals[0]).toMatchObject({ quantity: '10', costBase: '4303', proceeds: '4997.2727272727', heldOverTwelveMonths: true });
      expect(body.realized.disposals[1]).toMatchObject({ quantity: '1', costBase: '481.5', heldOverTwelveMonths: false });
      expect(body.realized.totals).toEqual([{ currency: 'USD', proceeds: '5497', costBase: '4784.5', gain: '712.5' }]);

      expect(body.dividends.totals).toEqual(
        expect.arrayContaining([
          { currency: 'USD', grossAmount: '10', withholdingTax: '1.5', netAmount: '8.5', frankingCredits: '0' },
          { currency: 'AUD', grossAmount: '30', withholdingTax: '0', netAmount: '30', frankingCredits: '8' },
        ]),
      );
      expect(body.notes.join(' ')).toMatch(/not tax advice/);
    });

    it('skips price lookups when asked', async () => {
      const { body } = await as(tokenA).get(`/api/accounts/${accountId}/portfolio?prices=false`).expect(200);
      expect(body.holdings[0]).toMatchObject({ price: null, marketValue: null });
    });

    it('does not value a holding with a price in another currency', async () => {
      t.prices.setPrice('VAS.AX', '70', 'USD');
      const { body } = await as(tokenA).get(`/api/accounts/${accountId}/portfolio`).expect(200);
      const vas = body.holdings.find((h: { symbol: string }) => h.symbol === 'VAS.AX');
      expect(vas.marketValue).toBeNull();
      expect(vas.priceError).toMatch(/quoted in USD/);
      t.prices.clear();
    });

    it('rejects underdetermined and inconsistent trades', async () => {
      const under = await tx({ type: 'BUY', date: '2025-05-01', symbol: 'VOO', currency: 'USD', quantity: '1', unitPrice: '1' }).expect(400);
      expect(under.body.error.message).toMatch(/at least three/);
      const inconsistent = await tx({ type: 'BUY', date: '2025-05-01', symbol: 'VOO', currency: 'USD', quantity: '1', unitPrice: '1', fees: '1', total: '5' }).expect(400);
      expect(inconsistent.body.error.message).toMatch(/does not match total/);
    });

    it('rejects activity the ledger cannot support, and writes nothing', async () => {
      const before = (await as(tokenA).get(`/api/accounts/${accountId}/transactions`).expect(200)).body.length;
      const oversell = await tx({ type: 'SELL', date: '2025-05-01', symbol: 'VOO', currency: 'USD', quantity: '5', unitPrice: '1', fees: '0' }).expect(422);
      expect(oversell.body.error).toMatchObject({ code: 'ledger_violation' });
      await tx({ type: 'WITHDRAWAL', date: '2025-05-01', currency: 'USD', amount: '100000' }).expect(422);
      await tx({ type: 'BUY', date: '2025-05-01', symbol: 'VOO', currency: 'AUD', quantity: '1', unitPrice: '1', fees: '0' }).expect(422);
      const after = (await as(tokenA).get(`/api/accounts/${accountId}/transactions`).expect(200)).body.length;
      expect(after).toBe(before);
    });

    it('filters transactions', async () => {
      const { body } = await as(tokenA).get(`/api/accounts/${accountId}/transactions?type=BUY&symbol=VOO`).expect(200);
      expect(body).toHaveLength(2);
      const dated = await as(tokenA).get(`/api/accounts/${accountId}/transactions?fromDate=2025-01-01`).expect(200);
      expect(dated.body.every((row: { date: string }) => row.date >= '2025-01-01')).toBe(true);
    });
  });

  describe('editing and deleting transactions', () => {
    let accountId: string;
    beforeAll(async () => {
      accountId = (await as(tokenA).post('/api/accounts', { name: 'Edits' }).expect(201)).body.id;
    });

    it('recalculates the calculated field on edit, and on request with null', async () => {
      await as(tokenA).post(`/api/accounts/${accountId}/transactions`, { type: 'DEPOSIT', date: '2025-01-01', currency: 'USD', amount: '1000' }).expect(201);
      const buy = (await as(tokenA).post(`/api/accounts/${accountId}/transactions`, { type: 'BUY', date: '2025-01-02', symbol: 'AAPL', currency: 'USD', quantity: '2', unitPrice: '100', fees: '1' }).expect(201)).body;
      expect(buy.total).toBe('201');

      const edited = await as(tokenA).patch(`/api/transactions/${buy.id}`, { quantity: '3' }).expect(200);
      expect(edited.body).toMatchObject({ quantity: '3', total: '301', calculatedField: 'total' });

      const byTotal = await as(tokenA).patch(`/api/transactions/${buy.id}`, { total: '311', fees: null }).expect(200);
      expect(byTotal.body).toMatchObject({ fees: '11', total: '311', calculatedField: 'fees' });
    });

    it('refuses fields that do not apply to the type', async () => {
      const deposit = (await as(tokenA).get(`/api/accounts/${accountId}/transactions?type=DEPOSIT`).expect(200)).body[0];
      const response = await as(tokenA).patch(`/api/transactions/${deposit.id}`, { symbol: 'VOO' }).expect(400);
      expect(response.body.error.message).toMatch(/cannot be set on a DEPOSIT/);
    });

    it('refuses edits and deletes that would break later transactions', async () => {
      const deposit = (await as(tokenA).get(`/api/accounts/${accountId}/transactions?type=DEPOSIT`).expect(200)).body[0];
      await as(tokenA).patch(`/api/transactions/${deposit.id}`, { amount: '10' }).expect(422);
      await as(tokenA).patch(`/api/transactions/${deposit.id}`, { date: '2025-02-01' }).expect(422);
      await as(tokenA).delete(`/api/transactions/${deposit.id}`).expect(422);
      const unchanged = await as(tokenA).get(`/api/transactions/${deposit.id}`).expect(200);
      expect(unchanged.body).toMatchObject({ amount: '1000', date: '2025-01-01' });
    });

    it('deletes a transaction nothing depends on, and the derived state follows', async () => {
      const buy = (await as(tokenA).get(`/api/accounts/${accountId}/transactions?type=BUY`).expect(200)).body[0];
      await as(tokenA).delete(`/api/transactions/${buy.id}`).expect(200, { deleted: true });
      const { body } = await as(tokenA).get(`/api/accounts/${accountId}/portfolio?prices=false`).expect(200);
      expect(body.holdings).toEqual([]);
      expect(body.cash).toEqual([{ currency: 'USD', balance: '1000' }]);
    });
  });

  describe('isolation between users', () => {
    let accountA: string;
    let transactionA: string;

    beforeAll(async () => {
      accountA = (await as(tokenA).post('/api/accounts', { name: 'Private A' }).expect(201)).body.id;
      transactionA = (await as(tokenA).post(`/api/accounts/${accountA}/transactions`, { type: 'DEPOSIT', date: '2025-01-01', currency: 'AUD', amount: '500' }).expect(201)).body.id;
    });

    it("does not list another user's accounts", async () => {
      const { body } = await as(tokenB).get('/api/accounts').expect(200);
      expect(body.map((a: { id: string }) => a.id)).not.toContain(accountA);
    });

    it("answers 404 for every read and write of another user's account or transaction", async () => {
      const b = as(tokenB);
      await b.get(`/api/accounts/${accountA}`).expect(404);
      await b.patch(`/api/accounts/${accountA}`, { name: 'hijacked' }).expect(404);
      await b.delete(`/api/accounts/${accountA}?deleteTransactions=true`).expect(404);
      await b.get(`/api/accounts/${accountA}/transactions`).expect(404);
      await b.post(`/api/accounts/${accountA}/transactions`, { type: 'WITHDRAWAL', date: '2025-01-02', currency: 'AUD', amount: '500' }).expect(404);
      await b.get(`/api/accounts/${accountA}/portfolio`).expect(404);
      await b.get(`/api/transactions/${transactionA}`).expect(404);
      await b.patch(`/api/transactions/${transactionA}`, { amount: '1' }).expect(404);
      await b.delete(`/api/transactions/${transactionA}`).expect(404);
    });

    it("leaves the owner's data untouched", async () => {
      await as(tokenA).get(`/api/accounts/${accountA}`).expect(200).expect((r) => expect(r.body.name).toBe('Private A'));
      await as(tokenA).get(`/api/transactions/${transactionA}`).expect(200).expect((r) => expect(r.body.amount).toBe('500'));
    });
  });
});
