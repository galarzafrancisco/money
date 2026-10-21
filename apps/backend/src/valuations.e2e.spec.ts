import { DataSource } from 'typeorm';
import { callTool, createTestApp, type TestApp } from './test-support/test-app';
import { ValuationJobService } from './valuations/valuation-job.service';
import { ValuationsRepository } from './valuations/valuations.repository';

/**
 * The daily valuation job against the real app and database, with the mock
 * provider's closes pinned per date. The job is run with explicit "now"s.
 *
 * Calendar (March 2025): 3 Mon … 7 Fri, 8–9 weekend, 10 Mon (holiday here),
 * 11 Tue, 12 Wed, 13 Thu. US daylight saving starts on the 9th.
 */
describe('daily closing-price valuations', () => {
  let t: TestApp;
  let job: ValuationJobService;
  let tokenA: string;
  let tokenB: string;
  let mcpA: string;
  let brokerA: { id: string };
  let asxA: { id: string };
  let brokerB: { id: string };

  const at = (iso: string) => new Date(iso);
  const as = (token: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: unknown) => t.http.post(url).set('Authorization', `Bearer ${token}`).send(body as object),
    patch: (url: string, body: unknown) => t.http.patch(url).set('Authorization', `Bearer ${token}`).send(body as object),
    delete: (url: string) => t.http.delete(url).set('Authorization', `Bearer ${token}`),
  });
  const record = (token: string, accountId: string, body: Record<string, unknown>) => as(token).post(`/api/accounts/${accountId}/transactions`, body).expect(201);
  const history = async (token: string, query: string) => (await as(token).get(`/api/valuations?${query}`).expect(200)).body;
  const day = (body: { days: { date: string }[] }, date: string) => body.days.find((d) => d.date === date) as any;

  beforeAll(async () => {
    t = await createTestApp();
    job = t.app.get(ValuationJobService);
    tokenA = await t.token({ subject: 'valuer-a' });
    tokenB = await t.token({ subject: 'valuer-b' });
    mcpA = await t.token({ subject: 'valuer-a', audience: 'http://money.test/mcp' });

    const closes: Record<string, string> = {
      '2025-03-03': '110', '2025-03-04': '111', '2025-03-05': '112', '2025-03-06': '113', '2025-03-07': '114',
      '2025-03-11': '121', '2025-03-13': '123', '2025-03-14': '124',
    };
    for (const [date, close] of Object.entries(closes)) t.prices.setClose('VOO', date, close);
    t.prices.setClose('VAS.AX', '2025-03-04', '100');
    t.prices.setClose('VAS.AX', '2025-03-11', '102');
    t.prices.addHoliday('2025-03-10');
    t.prices.addHoliday('2025-03-12');

    brokerA = (await as(tokenA).post('/api/accounts', { name: 'US broker' }).expect(201)).body;
    asxA = (await as(tokenA).post('/api/accounts', { name: 'ASX broker', reportingCurrency: 'AUD' }).expect(201)).body;
    await record(tokenA, brokerA.id, { type: 'DEPOSIT', date: '2025-03-01', currency: 'USD', amount: '100000' });
    await record(tokenA, brokerA.id, { type: 'BUY', date: '2025-03-03', symbol: 'VOO', currency: 'USD', quantity: '10', unitPrice: '100', fees: '0' });
    await record(tokenA, brokerA.id, { type: 'BUY', date: '2025-03-05', symbol: 'VOO', currency: 'USD', quantity: '5', unitPrice: '110', fees: '0' });
    await record(tokenA, brokerA.id, { type: 'SELL', date: '2025-03-07', symbol: 'VOO', currency: 'USD', quantity: '8', unitPrice: '115', fees: '0' });
    await record(tokenA, asxA.id, { type: 'DEPOSIT', date: '2025-03-01', currency: 'AUD', amount: '10000' });
    await record(tokenA, asxA.id, { type: 'BUY', date: '2025-03-04', symbol: 'VAS.AX', currency: 'AUD', quantity: '20', unitPrice: '99', fees: '0' });

    brokerB = (await as(tokenB).post('/api/accounts', { name: 'B broker' }).expect(201)).body;
    await record(tokenB, brokerB.id, { type: 'DEPOSIT', date: '2025-03-01', currency: 'USD', amount: '5000' });
    await record(tokenB, brokerB.id, { type: 'BUY', date: '2025-03-05', symbol: 'VOO', currency: 'USD', quantity: '1', unitPrice: '100', fees: '0' });
  });
  afterAll(() => t.close());

  it('materialises every settled date from the first purchase, with historical quantities and closes', async () => {
    // Wednesday 12th 08:00 UTC: everything up to Tuesday the 11th has closed
    const summary = await job.runOnce(at('2025-03-12T08:00:00Z'));
    expect(summary.skipped).toBe(false);
    expect(summary.settledThrough).toBe('2025-03-11');
    expect(summary.users.length).toBe(2);
    expect(summary.users.every((u) => u.datesComputed > 0 && !u.error)).toBe(true);

    const body = await history(tokenA, 'fromDate=2025-03-01&toDate=2025-03-31&include=holdings');
    expect(body.days.map((d: { date: string }) => d.date)).toEqual([
      '2025-03-03', '2025-03-04', '2025-03-05', '2025-03-06', '2025-03-07', '2025-03-08', '2025-03-09', '2025-03-10', '2025-03-11',
    ]);

    const voo = (date: string) => day(body, date).holdings.find((h: { symbol: string }) => h.symbol === 'VOO');
    expect(voo('2025-03-03')).toMatchObject({ accountId: brokerA.id, quantity: '10', costBase: '1000', marketValue: '1100', price: { status: 'CLOSE', close: '110', tradingDate: '2025-03-03', currency: 'USD', source: 'mock', isMock: true, exchangeTimezone: 'America/New_York', closeTime: '2025-03-03T21:00:00.000Z' } });
    expect(voo('2025-03-05')).toMatchObject({ quantity: '15', marketValue: '1680' });
    // After selling 8 FIFO on the 7th: 2 left of the first lot, all 5 of the second
    expect(voo('2025-03-07')).toMatchObject({ quantity: '7', costBase: '750', marketValue: '798' });
    expect(voo('2025-03-07').lots).toEqual([
      { lotId: expect.any(String), acquiredOn: '2025-03-03', quantity: '2', costBase: '200', marketValue: '228' },
      { lotId: expect.any(String), acquiredOn: '2025-03-05', quantity: '5', costBase: '550', marketValue: '570' },
    ]);
    // Weekend and the Monday holiday use Friday's close, labelled as such
    expect(voo('2025-03-08').price).toMatchObject({ status: 'NON_TRADING_DAY', tradingDate: '2025-03-07', close: '114' });
    expect(voo('2025-03-10').price).toMatchObject({ status: 'NON_TRADING_DAY', tradingDate: '2025-03-07' });
    // After the DST change, the close is at 20:00 UTC
    expect(voo('2025-03-11')).toMatchObject({ marketValue: '847', price: { status: 'CLOSE', closeTime: '2025-03-11T20:00:00.000Z' } });

    // The ASX holding: bought on the 4th, so absent on the 3rd; Sydney close at 16:00 AEDT = 05:00 UTC
    expect(day(body, '2025-03-03').holdings.map((h: { symbol: string }) => h.symbol)).toEqual(['VOO']);
    const vas = day(body, '2025-03-04').holdings.find((h: { symbol: string }) => h.symbol === 'VAS.AX');
    expect(vas).toMatchObject({ accountId: asxA.id, currency: 'AUD', quantity: '20', marketValue: '2000', price: { status: 'CLOSE', exchangeTimezone: 'Australia/Sydney', closeTime: '2025-03-04T05:00:00.000Z' } });

    // Totals stay per currency and flag mock data
    const totals = day(body, '2025-03-11');
    expect(totals.complete).toBe(true);
    expect(totals.includesMockPrices).toBe(true);
    expect(totals.totals.byCurrency).toEqual([
      { currency: 'AUD', marketValue: '2040', costBase: '1980', holdings: 1, unvaluedHoldings: 0, provisionalHoldings: 0 },
      { currency: 'USD', marketValue: '847', costBase: '750', holdings: 1, unvaluedHoldings: 0, provisionalHoldings: 0 },
    ]);
    expect(totals.totals.converted).toBeNull();
  });

  it('is idempotent: re-running computes nothing new and never duplicates rows', async () => {
    const countRows = async () => Number((await t.app.get(DataSource).query(`SELECT COUNT(*) AS n FROM valuation_holdings`))[0].n);
    const before = await countRows();
    const again = await job.runOnce(at('2025-03-12T09:00:00Z'));
    expect(again.users.every((u) => u.datesComputed === 0)).toBe(true);
    // Forcing a full recompute rewrites the same rows
    await as(tokenA).post('/api/valuations/recompute', { fromDate: '2025-03-01' }).expect(202);
    const forced = await job.runOnce(at('2025-03-12T09:30:00Z'));
    expect(forced.users.find((u) => u.datesComputed > 0)?.datesComputed).toBe(9);
    expect(await countRows()).toBe(before);
  });

  it('only lets one run hold the lease at a time', async () => {
    const repo = t.app.get(ValuationsRepository);
    expect(await repo.acquireLease('someone-else', 5)).toBe(true);
    const skipped = await job.runOnce(at('2025-03-12T10:00:00Z'));
    expect(skipped).toMatchObject({ skipped: true });
    await repo.releaseLease('someone-else', { status: 'ok', error: null, summary: {} });
  });

  it('flags a weekday without a close as pending and resolves it once a later session reveals a holiday', async () => {
    // Thursday 13th 08:00 UTC: Wednesday the 12th has no close (a holiday nobody has confirmed yet)
    await job.runOnce(at('2025-03-13T08:00:00Z'));
    let body = await history(tokenA, 'fromDate=2025-03-12&toDate=2025-03-12&include=holdings');
    expect(day(body, '2025-03-12').complete).toBe(false);
    const pending = day(body, '2025-03-12').holdings.find((h: { symbol: string }) => h.symbol === 'VOO');
    expect(pending).toMatchObject({ marketValue: '847', price: { status: 'PRICE_PENDING', tradingDate: '2025-03-11' } });
    expect(day(body, '2025-03-12').totals.byCurrency.find((c: { currency: string }) => c.currency === 'USD').provisionalHoldings).toBe(1);
    expect((await as(tokenA).get('/api/valuations/status').expect(200)).body).toMatchObject({ latestValuationDate: '2025-03-12', partialDays: 1 });

    // Friday 14th: Thursday's session closed, so the 12th was a non-trading day
    await job.runOnce(at('2025-03-14T08:00:00Z'));
    body = await history(tokenA, 'fromDate=2025-03-12&toDate=2025-03-13&include=holdings');
    expect(day(body, '2025-03-12').complete).toBe(true);
    expect(day(body, '2025-03-12').holdings.find((h: { symbol: string }) => h.symbol === 'VOO').price).toMatchObject({ status: 'NON_TRADING_DAY', tradingDate: '2025-03-11' });
    expect(day(body, '2025-03-13').holdings.find((h: { symbol: string }) => h.symbol === 'VOO').price).toMatchObject({ status: 'CLOSE', close: '123' });
  });

  it('records provider failures as missing prices, never as cost or stale closes, and retries them', async () => {
    const account = (await as(tokenB).post('/api/accounts', { name: 'B fail' }).expect(201)).body;
    await record(tokenB, account.id, { type: 'DEPOSIT', date: '2025-03-10', currency: 'USD', amount: '1000' });
    await record(tokenB, account.id, { type: 'BUY', date: '2025-03-13', symbol: 'FLAKY', currency: 'USD', quantity: '2', unitPrice: '50', fees: '0' });
    t.prices.setFailing('FLAKY');
    await job.runOnce(at('2025-03-14T09:00:00Z'));
    let body = await history(tokenB, `fromDate=2025-03-13&toDate=2025-03-13&include=holdings&accountId=${account.id}`);
    expect(day(body, '2025-03-13').complete).toBe(false);
    expect(day(body, '2025-03-13').holdings[0]).toMatchObject({ symbol: 'FLAKY', marketValue: null, price: { status: 'MISSING', close: null, note: expect.stringMatching(/unavailable/) } });
    expect(day(body, '2025-03-13').totals.byCurrency).toEqual([{ currency: 'USD', marketValue: '0', costBase: '100', holdings: 1, unvaluedHoldings: 1, provisionalHoldings: 0 }]);

    t.prices.setFailing('FLAKY', false);
    t.prices.setClose('FLAKY', '2025-03-13', '55');
    await job.runOnce(at('2025-03-14T10:00:00Z'));
    body = await history(tokenB, `fromDate=2025-03-13&toDate=2025-03-13&include=holdings&accountId=${account.id}`);
    expect(day(body, '2025-03-13').holdings[0]).toMatchObject({ marketValue: '110', price: { status: 'CLOSE', close: '55' } });
  });

  it('re-values from the date of a backdated trade, edit or delete', async () => {
    const extra = await record(tokenA, brokerA.id, { type: 'BUY', date: '2025-03-04', symbol: 'VOO', currency: 'USD', quantity: '1', unitPrice: '100', fees: '0' });
    expect((await as(tokenA).get('/api/valuations/status').expect(200)).body.pendingRecomputeFrom).toBe('2025-03-04');
    await job.runOnce(at('2025-03-14T11:00:00Z'));
    let body = await history(tokenA, 'fromDate=2025-03-03&toDate=2025-03-13&include=holdings&symbol=VOO');
    const qty = (date: string) => day(body, date).holdings[0].quantity;
    expect([qty('2025-03-03'), qty('2025-03-04'), qty('2025-03-05'), qty('2025-03-13')]).toEqual(['10', '11', '16', '8']);
    expect((await as(tokenA).get('/api/valuations/status').expect(200)).body.pendingRecomputeFrom).toBeNull();

    await as(tokenA).delete(`/api/transactions/${extra.body.id}`).expect(200);
    await job.runOnce(at('2025-03-14T12:00:00Z'));
    body = await history(tokenA, 'fromDate=2025-03-03&toDate=2025-03-13&include=holdings&symbol=VOO');
    expect([qty('2025-03-03'), qty('2025-03-04'), qty('2025-03-05'), qty('2025-03-13')]).toEqual(['10', '10', '15', '7']);
  });

  it('keeps every user to their own valuations, over REST and MCP', async () => {
    const a = await history(tokenA, 'fromDate=2025-03-01&toDate=2025-03-31&include=holdings');
    const b = await history(tokenB, 'fromDate=2025-03-01&toDate=2025-03-31&include=holdings');
    const accountsOf = (body: { days: { holdings: { accountId: string }[] }[] }) => new Set(body.days.flatMap((d) => d.holdings.map((h) => h.accountId)));
    expect([...accountsOf(a)].sort()).toEqual([brokerA.id, asxA.id].sort());
    expect(accountsOf(b).has(brokerA.id)).toBe(false);
    expect(accountsOf(b).has(brokerB.id)).toBe(true);
    expect(day(b, '2025-03-05').holdings.find((h: { symbol: string }) => h.symbol === 'VOO').quantity).toBe('1');

    // Another user's account is "not found"
    await as(tokenB).get(`/api/valuations?accountId=${brokerA.id}`).expect(404);
    await as(tokenB).post('/api/valuations/recompute', { fromDate: '2025-03-01', accountId: brokerA.id }).expect(404);

    const tool = await callTool(t, mcpA, 'get_valuation_history', { fromDate: '2025-03-11', toDate: '2025-03-11', include: 'holdings' });
    expect(tool.isError).toBe(false);
    expect(tool.data.days[0].holdings.map((h: { accountId: string }) => h.accountId).sort()).toEqual([brokerA.id, asxA.id].sort());
    const status = await callTool(t, mcpA, 'get_valuation_status');
    expect(status.data).toMatchObject({ priceProvider: 'mock', priceProviderIsMock: true, earliestValuationDate: '2025-03-03' });
    expect(JSON.stringify(status.data)).not.toContain(brokerB.id);
    const denied = await callTool(t, mcpA, 'get_valuation_history', { accountId: brokerB.id });
    expect(denied.isError).toBe(true);
    expect(denied.data.error.code).toBe('not_found');
  });

  it('filters by account subtree and converts totals only with explicit rates', async () => {
    const onlyAsx = await history(tokenA, `fromDate=2025-03-11&toDate=2025-03-11&accountId=${asxA.id}`);
    expect(day(onlyAsx, '2025-03-11').totals.byCurrency.map((c: { currency: string }) => c.currency)).toEqual(['AUD']);
    expect(day(onlyAsx, '2025-03-11').holdings).toBeUndefined();

    const converted = await history(tokenA, 'fromDate=2025-03-11&toDate=2025-03-11&baseCurrency=AUD&fxRates=USD:1.5');
    expect(day(converted, '2025-03-11').totals.converted).toEqual({ baseCurrency: 'AUD', marketValue: '3310.5', costBase: '3105' });
    expect(converted.fx.policy).toMatch(/Constant/);

    const missing = await as(tokenA).get('/api/valuations?fromDate=2025-03-11&toDate=2025-03-11&baseCurrency=AUD').expect(400);
    expect(missing.body.error.details.missingRates).toEqual(['USD']);
    await as(tokenA).get('/api/valuations?fromDate=2024-01-01&toDate=2025-03-11&include=holdings').expect(400);
    await as(tokenA).get('/api/valuations?fromDate=2025-03-12&toDate=2025-03-11').expect(400);
  });

  it('removes a user\'s valuations of an account that is deleted', async () => {
    const account = (await as(tokenB).post('/api/accounts', { name: 'B short-lived' }).expect(201)).body;
    await record(tokenB, account.id, { type: 'DEPOSIT', date: '2025-03-10', currency: 'USD', amount: '1000' });
    await record(tokenB, account.id, { type: 'BUY', date: '2025-03-11', symbol: 'VOO', currency: 'USD', quantity: '1', unitPrice: '100', fees: '0' });
    await job.runOnce(at('2025-03-14T13:00:00Z'));
    expect((await history(tokenB, `accountId=${account.id}&fromDate=2025-03-11&toDate=2025-03-13`)).days[0].totals.byCurrency).toHaveLength(1);
    await as(tokenB).delete(`/api/accounts/${account.id}?deleteTransactions=true`).expect(200);
    const after = await history(tokenB, 'fromDate=2025-03-11&toDate=2025-03-13&include=holdings');
    expect(after.days.flatMap((d: { holdings: { accountId: string }[] }) => d.holdings.map((h) => h.accountId))).not.toContain(account.id);
  });
});
