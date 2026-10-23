import { DataSource } from 'typeorm';
import { callTool, createTestApp, undoMigrationsThrough, type TestApp } from './test-support/test-app';

/**
 * The portfolio dashboard over REST and MCP. One user with cash buckets, two
 * share accounts holding the same ticker, and a super fund with a share
 * subaccount, so double counting would show up in the totals.
 */
describe('dashboard', () => {
  let t: TestApp;
  let token: string;
  let otherToken: string;
  const ids: Record<string, string> = {};
  const cats: Record<string, string> = {};

  const as = (tok: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${tok}`),
    post: (url: string, body: unknown) => t.http.post(url).set('Authorization', `Bearer ${tok}`).send(body as object),
    put: (url: string, body: unknown) => t.http.put(url).set('Authorization', `Bearer ${tok}`).send(body as object),
  });
  const me = () => as(token);
  const dashboard = (query = '') => me().get(`/api/dashboard${query}`).expect(200).then((r) => r.body);

  beforeAll(async () => {
    t = await createTestApp();
    token = await t.token({ subject: 'dash-user' });
    otherToken = await t.token({ subject: 'dash-other' });
    t.prices.setPrice('VOO', '500', 'USD');
    t.prices.setPrice('TSLA', '200', 'USD');
    t.prices.setPrice('VAS.AX', '110', 'AUD');

    const post = (url: string, body: unknown) => me().post(url, body).expect(201).then((r) => r.body);
    for (const name of ['emergency fund', 'term deposits', 'alpha', 'broad-market etf', 'crypto']) cats[name] = (await post('/api/categories', { name })).id;
    const account = async (key: string, body: object) => (ids[key] = (await post('/api/accounts', body)).id);
    await account('bank', { name: 'Bank', type: 'CASH' });
    await account('emergency', { name: 'Emergency Fund', type: 'CASH', parentAccountId: ids.bank, categoryId: cats['emergency fund'] });
    await account('td', { name: 'Term Deposit', type: 'CASH', parentAccountId: ids.bank, categoryId: cats['term deposits'] });
    await account('stake', { name: 'Stake', categoryId: cats['broad-market etf'] });
    await account('commsec', { name: 'CommSec', categoryId: cats['broad-market etf'] });
    await account('ibkr', { name: 'IBKR' });
    await account('super', { name: 'AustralianSuper', type: 'SUPERANNUATION' });
    await account('superShares', { name: 'Member Direct', type: 'INVESTMENT', parentAccountId: ids.super });

    const tx = (key: string, body: object) => post(`/api/accounts/${ids[key]}/transactions`, { date: '2025-01-02', ...body });
    const dep = (key: string, amount: string, currency = 'AUD') => tx(key, { type: 'DEPOSIT', currency, amount });
    const buy = (key: string, symbol: string, currency: string, quantity: string, unitPrice: string) =>
      tx(key, { type: 'BUY', symbol, currency, quantity, unitPrice, fees: '0' });
    await dep('bank', '1000');
    await dep('emergency', '10000');
    await dep('td', '20000');
    await dep('stake', '10000', 'USD');
    await buy('stake', 'VOO', 'USD', '10', '400');
    await buy('stake', 'TSLA', 'USD', '10', '150');
    await me().put(`/api/accounts/${ids.stake}/holdings/TSLA/category`, { categoryId: cats.alpha }).expect(200);
    await dep('commsec', '5000');
    await buy('commsec', 'VAS.AX', 'AUD', '20', '100');
    await dep('ibkr', '2000', 'USD');
    await buy('ibkr', 'VOO', 'USD', '2', '400');
    await dep('super', '50000');
    await dep('superShares', '1000');
    await buy('superShares', 'VAS.AX', 'AUD', '5', '100');
  });
  afterAll(() => t.close());

  // AUD: cash 34000 outside super; VAS.AX 20 × 110 = 2200 (shares); super 50000 + 500 cash + 5 × 110 = 51050
  // USD: cash 4500 + 1200 = 5700; VOO 12 × 500 = 6000; TSLA 10 × 200 = 2000
  // At USD 1.5: total 87250 + 13700 × 1.5 = 107800

  it('splits total assets by asset class without double counting super, subaccounts or holdings', async () => {
    const body = await dashboard('?displayCurrency=AUD&fxRates=USD:1.5');
    expect(body.displayCurrency).toBe('AUD');
    expect(body.fx).toMatchObject({ complete: true, missing: [], rates: [{ currency: 'USD', rate: '1.5', source: 'manual', isMock: false }] });
    expect(body.total.byCurrency).toEqual([
      { currency: 'AUD', cash: '84500', holdings: '2750', total: '87250' },
      { currency: 'USD', cash: '5700', holdings: '8000', total: '13700' },
    ]);
    expect(body.total.converted.total).toBe('107800');
    expect(body.dailyChange).toEqual(expect.objectContaining({ byCurrency: expect.any(Array), holdingsIncluded: expect.any(Number), holdingsExcluded: expect.any(Number), complete: expect.any(Boolean) }));

    const byClass = Object.fromEntries(body.assetClasses.map((c: any) => [c.assetClass, c]));
    expect(Object.keys(byClass)).toEqual(['cash', 'shares', 'super']);
    expect(byClass.cash.totals.converted.total).toBe('42550');
    expect(byClass.shares.totals.converted.total).toBe('14200');
    expect(byClass.super.totals.converted.total).toBe('51050');
    expect([byClass.cash.percentOfTotal, byClass.shares.percentOfTotal, byClass.super.percentOfTotal]).toEqual(['39.47', '13.17', '47.36']);
    // The super fund's balance and the shares in its subaccount are both super, each once
    expect(byClass.super.accounts.map((a: any) => [a.accountPath, a.totals.converted.total])).toEqual([
      [['AustralianSuper'], '50000'],
      [['AustralianSuper', 'Member Direct'], '1050'],
    ]);
  });

  it('aggregates each ticker across accounts with explicit share-portfolio and total denominators', async () => {
    const body = await dashboard('?fxRates=USD:1.5');
    expect(body.shares.totals.converted.total).toBe('14200');
    expect(body.shares.percentOfTotal).toBe('13.17');
    const tickers = body.shares.tickers.map((tk: any) => [tk.symbol, tk.quantity, tk.value, tk.convertedValue, tk.percentOfShares, tk.percentOfTotal]);
    expect(tickers).toEqual([
      ['VOO', '12', '6000', '9000', '63.38', '8.35'],
      ['TSLA', '10', '2000', '3000', '21.13', '2.78'],
      // Only the 20 held outside super; the 5 in the super subaccount count as super
      ['VAS.AX', '20', '2200', '2200', '15.49', '2.04'],
    ]);
    const voo = body.shares.tickers[0];
    expect(voo.positions.map((p: any) => [p.accountPath, p.quantity])).toEqual([
      [['Stake'], '10'],
      [['IBKR'], '2'],
    ]);
    expect(voo.priceStatus).toBe('MOCK');
    expect(body.valuation).toMatchObject({ status: 'COMPLETE', usesMockPrices: true, holdings: 5, mockPriced: 5, costFallback: 0 });
  });

  it('partitions by user-defined category, listing empty categories and adding up to the total', async () => {
    const body = await dashboard('?fxRates=USD:1.5');
    const byName = Object.fromEntries(body.categories.map((c: any) => [c.category?.name ?? 'Uncategorized', c]));
    expect(body.categories.map((c: any) => c.category?.name ?? null)).toEqual(['alpha', 'broad-market etf', 'crypto', 'emergency fund', 'term deposits', null]);
    expect(byName['emergency fund'].totals.converted.total).toBe('10000');
    expect(byName['term deposits'].totals.converted.total).toBe('20000');
    expect(byName.alpha.totals.converted.total).toBe('3000');
    expect(byName['broad-market etf'].totals.converted.total).toBe('19450');
    expect(byName.crypto.totals.converted.total).toBe('0');
    expect(byName.crypto.items).toEqual([]);
    expect(byName.Uncategorized.totals.converted.total).toBe('55350');
    expect(byName.alpha.items[0]).toMatchObject({ symbol: 'TSLA', categorySource: 'holding', assetClass: 'shares', priceStatus: 'MOCK' });
    const sum = body.categories.reduce((acc: number, c: any) => acc + Number(c.totals.converted.total), 0);
    expect(String(sum)).toBe(body.total.converted.total);
  });

  it('gives top-level accounts including their subaccounts, adding up to the total', async () => {
    const body = await dashboard('?fxRates=USD:1.5');
    expect(body.accounts.map((a: any) => [a.name, a.type, a.subaccounts, a.totals.converted.total])).toEqual([
      ['AustralianSuper', 'SUPERANNUATION', 1, '51050'],
      ['Bank', 'CASH', 2, '31000'],
      ['CommSec', 'INVESTMENT', 0, '5200'],
      ['IBKR', 'INVESTMENT', 0, '3300'],
      ['Stake', 'INVESTMENT', 0, '17250'],
    ]);
  });

  it('switches display currency without touching recorded transactions', async () => {
    const before = (await me().get(`/api/accounts/${ids.stake}/transactions`).expect(200)).body;
    const usd = await dashboard('?displayCurrency=usd&fxRates=AUD:0.65');
    expect(usd.displayCurrency).toBe('USD');
    expect(usd.total.converted).toMatchObject({ baseCurrency: 'USD', total: '70412.5' });
    expect(usd.total.byCurrency[0]).toEqual({ currency: 'AUD', cash: '84500', holdings: '2750', total: '87250' });
    const after = (await me().get(`/api/accounts/${ids.stake}/transactions`).expect(200)).body;
    expect(after).toEqual(before);
  });

  it('looks up missing rates from the price provider, with provenance', async () => {
    const body = await dashboard('?displayCurrency=AUD');
    expect(body.fx.rates).toEqual([{ currency: 'USD', rate: '1.538462', source: 'market', provider: 'mock', asOf: expect.any(String), isMock: true, isStale: false }]);
    expect(body.fx.complete).toBe(true);
    expect(body.total.converted.baseCurrency).toBe('AUD');
    expect(body.warnings.join(' ')).toMatch(/exchange rates are mock/);
  });

  it('flags holdings valued at cost when no usable price exists', async () => {
    t.prices.setPrice('TSLA', '200', 'EUR');
    try {
      const body = await dashboard('?fxRates=USD:1.5');
      const tsla = body.shares.tickers.find((tk: any) => tk.symbol === 'TSLA');
      expect(tsla).toMatchObject({ priceStatus: 'COST_FALLBACK', value: '1500', price: null });
      expect(body.valuation).toMatchObject({ status: 'PARTIAL', costFallback: 1 });
      expect(body.warnings.join(' ')).toMatch(/TSLA in "Stake" is valued at cost base/);
    } finally {
      t.prices.setPrice('TSLA', '200', 'USD');
    }
  });

  it('leaves converted figures and percentages out when a rate is unavailable, rather than undercounting', async () => {
    t.prices.setFxRate('USD', 'AUD', null);
    const body = await dashboard('?displayCurrency=AUD');
    expect(body.fx).toMatchObject({ complete: false, rates: [], missing: [{ currency: 'USD', reason: expect.stringMatching(/No USD→AUD exchange rate/) }] });
    expect(body.total.converted).toBeNull();
    expect(body.total.byCurrency).toHaveLength(2);
    expect(body.assetClasses.every((c: any) => c.percentOfTotal === null && c.totals.converted === null)).toBe(true);
    expect(body.shares.tickers.every((tk: any) => tk.convertedValue === null && tk.percentOfShares === null)).toBe(true);
    expect(body.valuation.status).toBe('PARTIAL');
    expect(body.warnings.join(' ')).toMatch(/No USD→AUD rate/);
    // A manual rate fills the gap
    const manual = await dashboard('?displayCurrency=AUD&fxRates=USD:1.5');
    expect(manual.total.converted.total).toBe('107800');
  });

  it('rejects malformed options', async () => {
    await me().get('/api/dashboard?displayCurrency=AUDX').expect(400);
    await me().get('/api/dashboard?fxRates=USD:-1').expect(400);
  });

  it('serves the same dashboard over MCP', async () => {
    const mcp = await t.token({ subject: 'dash-user', audience: t.config.auth.mcpResourceUrl });
    const result = await callTool(t, mcp, 'get_dashboard', { displayCurrency: 'AUD', fxRates: { USD: '1.5' } });
    expect(result.isError).toBe(false);
    expect(result.data.total.converted.total).toBe('107800');
    expect(result.data.shares.tickers[0].symbol).toBe('VOO');
  });

  describe('user isolation', () => {
    it("never includes another user's accounts, categories or holdings", async () => {
      const body = (await as(otherToken).get('/api/dashboard?fxRates=USD:1.5').expect(200)).body;
      expect(body.total.byCurrency).toEqual([]);
      expect(body.accounts).toEqual([]);
      expect(body.shares.tickers).toEqual([]);
      expect(body.categories).toEqual([{ category: null, totals: { byCurrency: [], converted: { baseCurrency: 'AUD', cash: '0', holdings: '0', total: '0' } }, percentOfTotal: null, items: [] }]);
      const json = JSON.stringify(body);
      for (const id of [...Object.values(ids), ...Object.values(cats)]) expect(json).not.toContain(id);

      const mcpOther = await t.token({ subject: 'dash-other', audience: t.config.auth.mcpResourceUrl });
      const result = await callTool(t, mcpOther, 'get_dashboard', {});
      expect(result.data.accounts).toEqual([]);
      expect(JSON.stringify(result.data)).not.toContain(ids.stake);
    });

    it('requires authentication', async () => {
      await t.http.get('/api/dashboard').expect(401);
    });
  });

  it('migrates SUPERANNUATION accounts down to OTHER and back up', async () => {
    const ds = t.app.get(DataSource);
    await undoMigrationsThrough(ds, 'SuperannuationAccounts1761600000000');
    const [row] = await ds.query(`SELECT "type" FROM "accounts" WHERE "id" = $1`, [ids.super]);
    expect(row.type).toBe('OTHER');
    await ds.runMigrations();
    const updated = await t.http.patch(`/api/accounts/${ids.super}`).set('Authorization', `Bearer ${token}`).send({ type: 'SUPERANNUATION' }).expect(200);
    expect(updated.body.type).toBe('SUPERANNUATION');
  });
});
