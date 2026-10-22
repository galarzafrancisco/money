import { DataSource } from 'typeorm';
import { callTool, createTestApp, type TestApp } from './test-support/test-app';
import { PriceHistoryService } from './valuations/price-history.service';
import { ValuationJobService } from './valuations/valuation-job.service';

/**
 * Store-first price history, on-demand as-of valuations, corrections, stale
 * quotes and historical FX, against the real app and database with the mock
 * provider standing in for Yahoo (every provider request is recorded).
 *
 * Calendar (June 2025): 2 Mon … 6 Fri, 9 Mon … 13 Fri, 16 Mon … 20 Fri.
 */
describe('store-first price history and as-of valuations', () => {
  let t: TestApp;
  let prices: PriceHistoryService;
  let job: ValuationJobService;
  let tokenA: string;
  let tokenB: string;
  let mcpA: string;

  const at = (iso: string) => new Date(iso);
  const as = (token: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: unknown) => t.http.post(url).set('Authorization', `Bearer ${token}`).send(body as object),
  });
  const record = (token: string, accountId: string, body: Record<string, unknown>) => as(token).post(`/api/accounts/${accountId}/transactions`, body).expect(201);
  const requests = (symbol: string) => t.prices.dailyCloseRequests.filter((r) => r.symbol === symbol).map(({ from, to }) => ({ from, to }));
  const storedRows = async (symbol: string) =>
    Number((await t.app.get(DataSource).query(`SELECT count(*)::int AS n FROM market_price_closes WHERE symbol = $1`, [symbol]))[0].n);

  beforeAll(async () => {
    t = await createTestApp();
    prices = t.app.get(PriceHistoryService);
    job = t.app.get(ValuationJobService);
    tokenA = await t.token({ subject: 'store-a' });
    tokenB = await t.token({ subject: 'store-b' });
    mcpA = await t.token({ subject: 'store-a', audience: 'http://money.test/mcp' });
  });
  afterAll(() => t.close());

  describe('cache-first lookups', () => {
    const now = at('2025-06-20T12:00:00Z');

    it('fetches a missing range once, then answers from the database', async () => {
      const first = await prices.getSeries(['CACHE1'], { from: '2025-06-02', to: '2025-06-13' }, now);
      expect(requests('CACHE1')).toEqual([{ from: '2025-06-02', to: '2025-06-13' }]);
      expect(first.get('CACHE1')!.series!.closes).toHaveLength(10);

      const again = await prices.getSeries(['CACHE1'], { from: '2025-06-02', to: '2025-06-13' }, now);
      const inside = await prices.getSeries(['CACHE1'], { from: '2025-06-04', to: '2025-06-10' }, now);
      expect(requests('CACHE1')).toHaveLength(1);
      expect(again.get('CACHE1')).toEqual(first.get('CACHE1'));
      expect(inside.get('CACHE1')!.series!.closes.map((c) => c.tradingDate)).toEqual(['2025-06-04', '2025-06-05', '2025-06-06', '2025-06-09', '2025-06-10']);
    });

    it('fetches only the dates outside the stored range, one request per gap', async () => {
      await prices.getSeries(['CACHE2'], { from: '2025-06-02', to: '2025-06-06' }, now);
      const wider = await prices.getSeries(['CACHE2'], { from: '2025-05-26', to: '2025-06-13' }, now);
      expect(requests('CACHE2')).toEqual([
        { from: '2025-06-02', to: '2025-06-06' },
        { from: '2025-05-26', to: '2025-06-01' },
        { from: '2025-06-07', to: '2025-06-13' },
      ]);
      expect(wider.get('CACHE2')!.series!.closes).toHaveLength(15);
      // A disjoint later range fills the gap in one request, keeping the stored range contiguous
      await prices.getSeries(['CACHE2'], { from: '2025-06-18', to: '2025-06-19' }, now);
      expect(requests('CACHE2').at(-1)).toEqual({ from: '2025-06-14', to: '2025-06-19' });
      await prices.getSeries(['CACHE2'], { from: '2025-05-26', to: '2025-06-19' }, now);
      expect(requests('CACHE2')).toHaveLength(4);
      expect(await storedRows('CACHE2')).toBe(19);
    });

    it('shares one provider request between concurrent lookups and never duplicates rows', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => prices.getSeries(['CONC'], { from: '2025-06-02', to: '2025-06-13' }, now)));
      expect(requests('CONC')).toHaveLength(1);
      expect(new Set(results.map((r) => JSON.stringify(r.get('CONC'))))).toHaveProperty('size', 1);
      expect(await storedRows('CONC')).toBe(10);
    });

    it('asks again about recent days without a close until a later session settles them', async () => {
      t.prices.addHoliday('2025-06-19');
      // Friday 20th 12:00 UTC: the 19th is a holiday and the 20th has not closed yet
      const early = await prices.getSeries(['RECENT'], { from: '2025-06-16', to: '2025-06-20' }, now);
      expect(early.get('RECENT')!.series!.closes.map((c) => c.tradingDate)).toEqual(['2025-06-16', '2025-06-17', '2025-06-18']);
      // Next day: only the days after the last stored close are asked for
      const later = await prices.getSeries(['RECENT'], { from: '2025-06-16', to: '2025-06-21' }, at('2025-06-21T12:00:00Z'));
      expect(requests('RECENT')).toEqual([
        { from: '2025-06-16', to: '2025-06-20' },
        { from: '2025-06-19', to: '2025-06-21' },
      ]);
      expect(later.get('RECENT')!.series!.closes.map((c) => c.tradingDate)).toEqual(['2025-06-16', '2025-06-17', '2025-06-18', '2025-06-20']);
    });

    it('uses stored closes during an outage and says so; with nothing stored it is an error, never a made-up price', async () => {
      await prices.getSeries(['DOWN1'], { from: '2025-06-02', to: '2025-06-06' }, now);
      t.prices.setFailing('DOWN1');
      t.prices.setFailing('DOWN2');
      const results = await prices.getSeries(['DOWN1', 'DOWN2'], { from: '2025-06-02', to: '2025-06-13' }, now);
      const down1 = results.get('DOWN1')!;
      expect(down1.series!.closes).toHaveLength(5);
      expect(down1.warning).toMatch(/simulated provider failure.*using stored closes \(complete through 2025-06-06/);
      expect(results.get('DOWN2')).toEqual({ error: expect.stringMatching(/simulated provider failure/) });
      t.prices.setFailing('DOWN1', false);
      t.prices.setFailing('DOWN2', false);
    });

    it('reports a symbol the provider does not know', async () => {
      t.prices.setUnknown('NOSUCH');
      expect((await prices.getSeries(['NOSUCH'], { from: '2025-06-02', to: '2025-06-06' }, now)).get('NOSUCH')).toEqual({ series: null });
    });
  });

  describe('valuations from the store', () => {
    let brokerA: { id: string };
    let brokerB: { id: string };

    beforeAll(async () => {
      brokerA = (await as(tokenA).post('/api/accounts', { name: 'A broker' }).expect(201)).body;
      brokerB = (await as(tokenB).post('/api/accounts', { name: 'B broker' }).expect(201)).body;
      t.prices.setClose('CORR', '2025-06-03', '50');
      t.prices.setClose('CORR', '2025-06-04', '51');
      t.prices.setClose('CORR', '2025-06-05', '52');
      t.prices.setClose('CORR', '2025-06-06', '53');
      t.prices.addSplit('SPLT', { date: '2025-06-05', numerator: '2', denominator: '1' });
      await record(tokenA, brokerA.id, { type: 'DEPOSIT', date: '2025-06-01', currency: 'USD', amount: '100000' });
      await record(tokenA, brokerA.id, { type: 'BUY', date: '2025-06-03', symbol: 'CORR', currency: 'USD', quantity: '10', unitPrice: '50', fees: '0' });
      await record(tokenA, brokerA.id, { type: 'BUY', date: '2025-06-03', symbol: 'SPLT', currency: 'USD', quantity: '4', unitPrice: '20', fees: '0' });
      await record(tokenB, brokerB.id, { type: 'DEPOSIT', date: '2025-06-01', currency: 'USD', amount: '1000' });
      await record(tokenB, brokerB.id, { type: 'BUY', date: '2025-06-04', symbol: 'CORR', currency: 'USD', quantity: '1', unitPrice: '51', fees: '0' });
      // Saturday 7th: everything up to Friday the 6th has closed
      await job.runOnce(at('2025-06-07T08:00:00Z'));
    });

    const holding = async (token: string, date: string, symbol: string) => {
      const body = (await as(token).get(`/api/valuations?fromDate=${date}&toDate=${date}&include=holdings`).expect(200)).body;
      return body.days[0]?.holdings.find((h: { symbol: string }) => h.symbol === symbol);
    };

    it('reuses stored closes on later runs: no provider request for finalised history', async () => {
      const before = requests('CORR').length;
      await as(tokenA).post('/api/valuations/recompute', { fromDate: '2025-06-03' }).expect(202);
      await job.runOnce(at('2025-06-07T09:00:00Z'));
      expect(requests('CORR').length).toBe(before);
      expect(await holding(tokenA, '2025-06-05', 'CORR')).toMatchObject({ quantity: '10', marketValue: '520', price: { status: 'CLOSE', close: '52' } });
    });

    it('re-values every holder when an explicit refresh finds a corrected close', async () => {
      t.prices.setClose('CORR', '2025-06-05', '60');
      // Without a refresh the stored close stands: finalised closes are immutable
      await as(tokenA).post('/api/valuations/recompute', { fromDate: '2025-06-05' }).expect(202);
      await job.runOnce(at('2025-06-07T10:00:00Z'));
      expect((await holding(tokenA, '2025-06-05', 'CORR')).marketValue).toBe('520');

      const refresh = await as(tokenA).post('/api/valuations/recompute', { fromDate: '2025-06-05', refreshPrices: true }).expect(202);
      expect(refresh.body.refreshedSymbols).toEqual(['CORR', 'SPLT']);
      await job.runOnce(at('2025-06-07T11:00:00Z'));
      // Another run picks up holders re-queued by the correction (user B)
      await job.runOnce(at('2025-06-07T11:05:00Z'));
      expect(await holding(tokenA, '2025-06-05', 'CORR')).toMatchObject({ marketValue: '600', price: { close: '60' } });
      expect(await holding(tokenB, '2025-06-05', 'CORR')).toMatchObject({ marketValue: '60', price: { close: '60' } });
      expect((await holding(tokenB, '2025-06-04', 'CORR')).marketValue).toBe('51');
      const revised = await t.app.get(DataSource).query(`SELECT to_char(trading_date, 'YYYY-MM-DD') AS d FROM market_price_closes WHERE symbol = 'CORR' AND revised_at IS NOT NULL`);
      expect(revised).toEqual([{ d: '2025-06-05' }]);
    });

    it('flags a split that happened while the holding was held', async () => {
      expect((await holding(tokenA, '2025-06-04', 'SPLT')).price.note).toBeNull();
      expect((await holding(tokenA, '2025-06-05', 'SPLT')).price.note).toMatch(/SPLT split 2:1 on 2025-06-05, while held/);
    });

    it('answers as-of from the snapshot, and reconstructs the same values on demand when it is out of date', async () => {
      const snapshot = (await as(tokenA).get('/api/valuations/as-of?date=2025-06-05').expect(200)).body;
      expect(snapshot).toMatchObject({ date: '2025-06-05', basis: 'SNAPSHOT', complete: true, pendingRecompute: false });

      await as(tokenA).post('/api/valuations/recompute', { fromDate: '2025-06-04' }).expect(202);
      const onDemand = (await as(tokenA).get('/api/valuations/as-of?date=2025-06-05').expect(200)).body;
      expect(onDemand).toMatchObject({ basis: 'ON_DEMAND', pendingRecompute: true, basisReason: expect.stringMatching(/backdated/) });
      expect(onDemand.holdings).toEqual(snapshot.holdings);
      expect(onDemand.totals).toEqual(snapshot.totals);

      // The history marks the affected dates too
      const history = (await as(tokenA).get('/api/valuations?fromDate=2025-06-03&toDate=2025-06-05').expect(200)).body;
      expect(history.days.map((d: { pendingRecompute: boolean }) => d.pendingRecompute)).toEqual([false, true, true]);
      await job.runOnce(at('2025-06-07T12:00:00Z'));
    });

    it('reflects a backdated trade on demand at once, and the job then agrees', async () => {
      await record(tokenA, brokerA.id, { type: 'BUY', date: '2025-06-04', symbol: 'CORR', currency: 'USD', quantity: '5', unitPrice: '51', fees: '0' });
      const onDemand = (await as(tokenA).get('/api/valuations/as-of?date=2025-06-05&symbol=CORR').expect(200)).body;
      expect(onDemand.basis).toBe('ON_DEMAND');
      expect(onDemand.holdings[0]).toMatchObject({ quantity: '15', marketValue: '900' });
      // Quantities are as of the date, never today's
      const before = (await as(tokenA).get('/api/valuations/as-of?date=2025-06-03&symbol=CORR').expect(200)).body;
      expect(before.holdings[0]).toMatchObject({ quantity: '10', marketValue: '500' });

      await job.runOnce(at('2025-06-07T13:00:00Z'));
      const snapshot = (await as(tokenA).get('/api/valuations/as-of?date=2025-06-05&symbol=CORR').expect(200)).body;
      expect(snapshot.basis).toBe('SNAPSHOT');
      expect(snapshot.holdings).toEqual(onDemand.holdings);
    });

    it('reconstructs a date before any snapshot, and refuses future dates', async () => {
      const early = (await as(tokenA).get('/api/valuations/as-of?date=2025-06-02').expect(200)).body;
      expect(early).toMatchObject({ basis: 'ON_DEMAND', holdings: [] });
      await as(tokenA).get('/api/valuations/as-of?date=2999-01-01').expect(400);
    });

    it('gives the same as-of answer over MCP and keeps users apart', async () => {
      const rest = (await as(tokenA).get('/api/valuations/as-of?date=2025-06-05').expect(200)).body;
      const tool = await callTool(t, mcpA, 'get_valuation_as_of', { date: '2025-06-05' });
      expect(tool.isError).toBe(false);
      expect(tool.data).toEqual(rest);
      await as(tokenB).get(`/api/valuations/as-of?date=2025-06-05&accountId=${brokerA.id}`).expect(404);
      const b = (await as(tokenB).get('/api/valuations/as-of?date=2025-06-05').expect(200)).body;
      expect(b.holdings.map((h: { accountId: string }) => h.accountId)).toEqual([brokerB.id]);
    });

    it('converts at each date\'s historical FX close, and says when a rate is unavailable instead of inventing one', async () => {
      t.prices.setClose('USDAUD=X', '2025-06-04', '1.5');
      t.prices.setClose('USDAUD=X', '2025-06-05', '1.6');
      const history = (await as(tokenB).get('/api/valuations?fromDate=2025-06-04&toDate=2025-06-05&baseCurrency=AUD').expect(200)).body;
      expect(history.days.map((d: { totals: { converted: { marketValue: string } } }) => d.totals.converted.marketValue)).toEqual(['76.5', '96']);
      expect(history.days[1].totals.converted.rates[0]).toMatchObject({ currency: 'USD', rate: '1.6', kind: 'HISTORICAL', tradingDate: '2025-06-05' });

      t.prices.setFxRate('USD', 'NZD', null);
      const noRate = (await as(tokenB).get('/api/valuations/as-of?date=2025-06-05&baseCurrency=NZD').expect(200)).body;
      expect(noRate.totals.converted).toBeNull();
      expect(noRate.totals.conversionUnavailable).toEqual([{ currency: 'USD', reason: expect.stringMatching(/no USD→NZD history/) }]);
      expect(noRate.warnings.join(' ')).toMatch(/No USD→NZD rate/);
    });
  });

  describe('latest quotes during an outage', () => {
    it('serves the last known price flagged stale, never a fabricated one', async () => {
      t.prices.setPrice('STALEQ', '42');
      const fresh = (await as(tokenA).get('/api/market-prices/STALEQ').expect(200)).body;
      expect(fresh).toMatchObject({ price: '42', isStale: false, staleReason: null, priceType: 'LAST', source: 'mock' });

      t.prices.setFailing('STALEQ');
      const stale = (await as(tokenA).get('/api/market-prices/STALEQ').expect(200)).body;
      expect(stale).toMatchObject({ price: '42', isStale: true, asOf: fresh.asOf, staleReason: expect.stringMatching(/simulated provider failure/) });

      // Nothing in memory: the latest stored close stands in, labelled as a close
      await prices.getSeries(['STALEC'], { from: '2025-06-02', to: '2025-06-06' }, at('2025-06-20T00:00:00Z'));
      t.prices.setFailing('STALEC');
      const fromStore = (await as(tokenA).get('/api/market-prices/STALEC').expect(200)).body;
      expect(fromStore).toMatchObject({ isStale: true, priceType: 'CLOSE', asOf: '2025-06-06T20:00:00.000Z' });

      // Never seen: an error, not a made-up or cost-based price
      t.prices.setFailing('NEVERSEEN');
      await as(tokenA).get('/api/market-prices/NEVERSEEN').expect(502);
      const viaMcp = await callTool(t, mcpA, 'get_market_price', { symbol: 'STALEQ' });
      expect(viaMcp.data).toMatchObject({ isStale: true, price: '42' });
      t.prices.setFailing('STALEQ', false);
      t.prices.setFailing('STALEC', false);
    });
  });

  it('migrates the price store down and back up', async () => {
    const ds = t.app.get(DataSource);
    await ds.undoLastMigration();
    const [{ exists }] = await ds.query(`SELECT to_regclass('market_price_series') IS NOT NULL AS exists`);
    expect(exists).toBe(false);
    await ds.runMigrations();
    expect(await storedRows('CACHE1')).toBe(10);
    const [{ adjustment }] = await ds.query(`SELECT DISTINCT adjustment FROM market_price_closes WHERE symbol = 'CACHE1'`);
    expect(adjustment).toBe('AS_TRADED');
  });
});
