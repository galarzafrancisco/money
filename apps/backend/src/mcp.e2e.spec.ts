import { callTool, createTestApp, type TestApp } from './test-support/test-app';

describe('MCP interface', () => {
  let t: TestApp;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    t = await createTestApp();
    tokenA = await t.token({ subject: 'mcp-user-a', audience: 'http://money.test/mcp' });
    tokenB = await t.token({ subject: 'mcp-user-b', audience: 'http://money.test/mcp' });
  });
  afterAll(() => t.close());

  describe('authentication', () => {
    it('refuses calls without a token, pointing at the MCP resource metadata', async () => {
      const response = await t.http
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(401);
      expect(response.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource/mcp');
    });

    it('refuses a REST token on the MCP endpoint', async () => {
      const restToken = await t.token({ subject: 'mcp-user-a', audience: 'http://money.test/api' });
      const result = await callTool(t, restToken, 'whoami');
      expect(result.status).toBe(401);
    });

    it('refuses untrusted and expired tokens', async () => {
      expect((await callTool(t, await t.token({ audience: 'http://money.test/mcp', foreignKey: true }), 'whoami')).status).toBe(401);
      expect((await callTool(t, await t.token({ audience: 'http://money.test/mcp', expiresInSeconds: -120 }), 'whoami')).status).toBe(401);
    });

    it('identifies the user from the token', async () => {
      const result = await callTool(t, tokenA, 'whoami');
      expect(result.data).toMatchObject({ issuer: 'https://taico.test', subject: 'mcp-user-a' });
    });
  });

  it('lists the tools', async () => {
    const response = await t.http
      .post('/mcp')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(200);
    const names = response.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'whoami', 'list_accounts', 'get_account', 'create_account', 'update_account', 'delete_account',
        'list_transactions', 'get_transaction', 'record_deposit', 'record_withdrawal', 'record_fx_conversion',
        'record_buy', 'record_sell', 'record_dividend', 'update_transaction', 'delete_transaction',
        'get_portfolio', 'get_market_price',
        'list_categories', 'get_category', 'create_category', 'update_category', 'delete_category',
        'set_holding_category', 'list_holding_categories', 'get_accounts_report', 'get_categories_report',
      ]),
    );
  });

  it('runs the same business rules as REST', async () => {
    const account = (await callTool(t, tokenA, 'create_account', { name: 'IBKR', reportingCurrency: 'AUD' })).data;
    expect(account).toMatchObject({ name: 'IBKR', type: 'INVESTMENT' });

    await callTool(t, tokenA, 'record_deposit', { accountId: account.id, date: '2025-01-01', currency: 'USD', amount: '1000', externalCurrency: 'AUD', externalAmount: '1550' });
    const fx = await callTool(t, tokenA, 'record_fx_conversion', { accountId: account.id, date: '2025-01-02', fromCurrency: 'USD', toCurrency: 'AUD', fromAmount: '100', toAmount: '155' });
    expect(fx.data).toMatchObject({ rate: '1.55', calculatedField: 'rate' });

    const buy = await callTool(t, tokenA, 'record_buy', { accountId: account.id, date: '2025-01-03', symbol: 'VTI', currency: 'USD', quantity: 2, unitPrice: '250', fees: '1' });
    expect(buy.data).toMatchObject({ total: '501', calculatedField: 'total' });

    const underdetermined = await callTool(t, tokenA, 'record_sell', { accountId: account.id, date: '2025-01-04', symbol: 'VTI', currency: 'USD', quantity: '1' });
    expect(underdetermined.isError).toBe(true);
    expect(underdetermined.data.error).toMatchObject({ code: 'validation_failed' });

    const oversell = await callTool(t, tokenA, 'record_sell', { accountId: account.id, date: '2025-01-04', symbol: 'VTI', currency: 'USD', quantity: '3', unitPrice: '260', fees: '1' });
    expect(oversell.isError).toBe(true);
    expect(oversell.data.error).toMatchObject({ code: 'ledger_violation' });

    const sell = await callTool(t, tokenA, 'record_sell', { accountId: account.id, date: '2025-01-05', symbol: 'VTI', currency: 'USD', quantity: '1', unitPrice: '260', total: '259' });
    expect(sell.data).toMatchObject({ fees: '1' });

    const dividend = await callTool(t, tokenA, 'record_dividend', { accountId: account.id, date: '2025-03-01', symbol: 'VTI', currency: 'USD', grossAmount: '2', netAmount: '1.7' });
    expect(dividend.data).toMatchObject({ withholdingTax: '0.3' });

    t.prices.setPrice('VTI', '270', 'USD');
    const portfolio = (await callTool(t, tokenA, 'get_portfolio', { accountId: account.id })).data;
    // USD: 1000 − 100 − 501 + 259 + 1.7
    expect(portfolio.cash).toEqual([
      { currency: 'AUD', balance: '155' },
      { currency: 'USD', balance: '659.7' },
    ]);
    expect(portfolio.holdings[0]).toMatchObject({ symbol: 'VTI', quantity: '1', costBase: '250.5', marketValue: '270', unrealizedGain: '19.5' });
    expect(portfolio.realized.totals).toEqual([{ currency: 'USD', proceeds: '259', costBase: '250.5', gain: '8.5' }]);

    const edited = await callTool(t, tokenA, 'update_transaction', { transactionId: buy.data.id, fees: '2' });
    expect(edited.data).toMatchObject({ total: '502' });
    const refusedDelete = await callTool(t, tokenA, 'delete_transaction', { transactionId: buy.data.id });
    expect(refusedDelete.data.error).toMatchObject({ code: 'ledger_violation' });

    const listed = await callTool(t, tokenA, 'list_transactions', { accountId: account.id, type: 'BUY' });
    expect(listed.data).toHaveLength(1);

    const quote = await callTool(t, tokenA, 'get_market_price', { symbol: 'vti' });
    expect(quote.data).toMatchObject({ symbol: 'VTI', price: '270', source: 'mock', isMock: true });
  });

  describe('isolation between users', () => {
    let accountA: string;
    let transactionA: string;

    beforeAll(async () => {
      accountA = (await callTool(t, tokenA, 'create_account', { name: 'Secret' })).data.id;
      transactionA = (await callTool(t, tokenA, 'record_deposit', { accountId: accountA, date: '2025-01-01', currency: 'AUD', amount: '100' })).data.id;
    });

    it("never shows another user's accounts", async () => {
      const list = (await callTool(t, tokenB, 'list_accounts')).data;
      expect(list.map((a: { id: string }) => a.id)).not.toContain(accountA);
    });

    it.each([
      ['get_account', () => ({ accountId: accountA })],
      ['update_account', () => ({ accountId: accountA, name: 'mine now' })],
      ['delete_account', () => ({ accountId: accountA, deleteTransactions: true })],
      ['list_transactions', () => ({ accountId: accountA })],
      ['record_withdrawal', () => ({ accountId: accountA, date: '2025-01-02', currency: 'AUD', amount: '100' })],
      ['get_portfolio', () => ({ accountId: accountA })],
      ['get_transaction', () => ({ transactionId: transactionA })],
      ['update_transaction', () => ({ transactionId: transactionA, amount: '1' })],
      ['delete_transaction', () => ({ transactionId: transactionA })],
    ])("answers not_found to %s on another user's data", async (tool, args) => {
      const result = await callTool(t, tokenB, tool, args());
      expect(result.isError).toBe(true);
      expect(result.data.error).toMatchObject({ code: 'not_found' });
    });

    it('ignores a userId smuggled into tool arguments', async () => {
      const me = (await callTool(t, tokenA, 'whoami')).data;
      const created = await callTool(t, tokenB, 'create_account', { name: 'B account', userId: me.id });
      expect(created.isError).toBe(false);
      const list = (await callTool(t, tokenA, 'list_accounts')).data;
      expect(list.map((a: { name: string }) => a.name)).not.toContain('B account');
    });

    it("leaves the owner's data untouched", async () => {
      expect((await callTool(t, tokenA, 'get_account', { accountId: accountA })).data.name).toBe('Secret');
      expect((await callTool(t, tokenA, 'get_transaction', { transactionId: transactionA })).data.amount).toBe('100');
    });
  });
});
