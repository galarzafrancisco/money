import { DataSource } from 'typeorm';
import { callTool, createTestApp, undoMigrationsThrough, type TestApp } from './test-support/test-app';
import { ValuationJobService } from './valuations/valuation-job.service';

/**
 * Stock splits end to end: the seeded TSLA splits, split-aware valuation
 * history (snapshots and on demand), provider-reported splits, trades
 * recorded before a split, ticker aliases, REST/MCP parity and the
 * migration. See docs/stock-splits.md.
 *
 * Calendar: 2020-08-28 Fri, 08-31 Mon. 2022-08-22 Mon … 08-26 Fri. 2025-06-02 Mon … 06-06 Fri.
 */
describe('stock splits', () => {
  let t: TestApp;
  let job: ValuationJobService;
  let ds: DataSource;
  let token: string;
  let mcp: string;
  let broker: { id: string };

  const at = (iso: string) => new Date(iso);
  const as = (tk: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${tk}`),
    post: (url: string, body: unknown) => t.http.post(url).set('Authorization', `Bearer ${tk}`).send(body as object),
  });
  const record = (accountId: string, body: Record<string, unknown>) => as(token).post(`/api/accounts/${accountId}/transactions`, body).expect(201);
  type Holding = { symbol: string; quantity: string; marketValue: string; price: { close: string; note: string | null }; split: { factor: string; adjustedQuantity: string; adjustedClose: string } };
  const tsla = (day: { holdings: Holding[] }) => day.holdings.find((h) => h.symbol === 'TSLA')!;

  beforeAll(async () => {
    t = await createTestApp();
    job = t.app.get(ValuationJobService);
    ds = t.app.get(DataSource);
    token = await t.token({ subject: 'splits-a' });
    mcp = await t.token({ subject: 'splits-a', audience: 'http://money.test/mcp' });
    broker = (await as(token).post('/api/accounts', { name: 'Broker' }).expect(201)).body;
    // As-traded closes around both TSLA splits, as Yahoo reports them once its adjustment is reversed
    for (const [date, close] of [
      ['2020-08-27', '2238.75'], ['2020-08-28', '2213.40'], ['2020-08-31', '498.32'], ['2020-09-01', '475.05'],
      ['2022-08-22', '869.74'], ['2022-08-23', '889.36'], ['2022-08-24', '891.29'], ['2022-08-25', '296.07'], ['2022-08-26', '288.09'],
    ]) t.prices.setClose('TSLA', date, close);
    await record(broker.id, { type: 'DEPOSIT', date: '2020-08-01', currency: 'USD', amount: '1000000' });
    // Recorded today in today's share basis, like a broker export: 645 shares, then 45 more
    await record(broker.id, { type: 'BUY', date: '2020-08-26', symbol: 'TSLA', currency: 'USD', quantity: '645', unitPrice: '134', fees: '0' });
    await record(broker.id, { type: 'BUY', date: '2021-03-01', symbol: 'TSLA', currency: 'USD', quantity: '45', unitPrice: '230', fees: '0' });
  });
  afterAll(() => t.close());

  it('seeds the verified TSLA splits and lists them on REST and MCP', async () => {
    const rest = (await as(token).get('/api/stock-splits?symbol=tsla').expect(200)).body;
    expect(rest.instrument).toBe('TSLA');
    expect(rest.splits.map((s: Record<string, string>) => [s.effectiveDate, s.numerator, s.denominator, s.ratio, s.provenance])).toEqual([
      ['2020-08-31', '5', '1', '5', 'VERIFIED'],
      ['2022-08-25', '3', '1', '3', 'VERIFIED'],
    ]);
    expect(rest.splits[0].explanation).toMatch(/each TSLA share held is 5 shares/);
    const tool = await callTool(t, mcp, 'list_stock_splits', { symbol: 'TSLA' });
    expect(tool.isError).toBe(false);
    expect(tool.data).toEqual(rest);

    const ranged = (await as(token).get('/api/stock-splits?symbol=TSLA&fromDate=2021-01-01&toDate=2022-12-31').expect(200)).body;
    expect(ranged.splits.map((s: { effectiveDate: string }) => s.effectiveDate)).toEqual(['2022-08-25']);
    await as(token).get('/api/stock-splits?fromDate=2023-01-01&toDate=2022-01-01').expect(400);
  });

  it('gives the cumulative factor as of a date, with the splits that make it up', async () => {
    const before = await callTool(t, mcp, 'get_split_adjustment', { symbol: 'TSLA', date: '2020-08-28' });
    expect(before.data).toMatchObject({ instrument: 'TSLA', date: '2020-08-28', factor: '15' });
    expect(before.data.splitsAfterDate.map((s: { effectiveDate: string }) => s.effectiveDate)).toEqual(['2020-08-31', '2022-08-25']);
    // The ex-date is already in the new basis; weekends carry the basis before
    expect((await callTool(t, mcp, 'get_split_adjustment', { symbol: 'TSLA', date: '2020-08-31' })).data.factor).toBe('3');
    expect((await callTool(t, mcp, 'get_split_adjustment', { symbol: 'TSLA', date: '2020-08-30' })).data.factor).toBe('15');
    const after = (await as(token).get('/api/stock-splits/adjustment?symbol=TSLA&date=2022-08-25').expect(200)).body;
    expect(after).toMatchObject({ factor: '1', splitsAfterDate: [] });
    expect(after.splitsOnOrBeforeDate).toHaveLength(2);
    expect((await as(token).get('/api/stock-splits/adjustment?symbol=VOO&date=2020-01-01').expect(200)).body.factor).toBe('1');
  });

  it('requires a signed-in user', async () => {
    await t.http.get('/api/stock-splits').expect(401);
  });

  it('values history across the 2022 split without a cliff, snapshots and MCP alike', async () => {
    // Only the days around the split: an older first purchase would make this a long backfill
    await ds.query(`UPDATE transactions SET date = '2022-08-22' WHERE symbol = 'TSLA' AND date = '2020-08-26'`);
    await ds.query(`UPDATE transactions SET date = '2022-08-01' WHERE type = 'DEPOSIT'`);
    await ds.query(`UPDATE transactions SET date = '2022-08-22' WHERE symbol = 'TSLA' AND date = '2021-03-01'`);
    await job.runOnce(at('2022-08-27T08:00:00Z'));
    const history = (await as(token).get('/api/valuations?fromDate=2022-08-22&toDate=2022-08-26&include=holdings').expect(200)).body;
    const days = history.days as { date: string; holdings: Holding[]; totals: { byCurrency: { marketValue: string }[] } }[];
    expect(days.map((d) => [d.date, tsla(d).quantity, tsla(d).price.close, tsla(d).marketValue])).toEqual([
      ['2022-08-22', '230', '869.74', '200040.2'],
      ['2022-08-23', '230', '889.36', '204552.8'],
      ['2022-08-24', '230', '891.29', '204996.7'],
      ['2022-08-25', '690', '296.07', '204288.3'],
      ['2022-08-26', '690', '288.09', '198782.1'],
    ]);
    expect(tsla(days[2]).split).toEqual({ basis: 'VALUATION_DATE', factor: '3', adjustedQuantity: '690', adjustedClose: '297.0966666667' });
    expect(tsla(days[3]).split).toMatchObject({ factor: '1', adjustedQuantity: '690', adjustedClose: '296.07' });
    // No artificial ~67% drop; the real move is kept
    const [v24, v25] = [Number(days[2].totals.byCurrency[0].marketValue), Number(days[3].totals.byCurrency[0].marketValue)];
    expect(Math.abs(v25 / v24 - 1)).toBeLessThan(0.01);
    expect(history.splits).toEqual([expect.objectContaining({ symbol: 'TSLA', effectiveDate: '2022-08-25', ratio: '3', provenance: 'VERIFIED' })]);
    expect(history.notes.join(' ')).toMatch(/Stock splits are modelled/);

    const tool = await callTool(t, mcp, 'get_valuation_history', { fromDate: '2022-08-22', toDate: '2022-08-26', include: 'holdings' });
    expect(tool.data.days).toEqual(history.days);
    expect(tool.data.splits).toEqual(history.splits);
  });

  it('reconstructs a date on demand with the same split-adjusted figures as the snapshot', async () => {
    const snapshot = (await as(token).get('/api/valuations/as-of?date=2022-08-24').expect(200)).body;
    expect(snapshot.basis).toBe('SNAPSHOT');
    await as(token).post('/api/valuations/recompute', { fromDate: '2022-08-22' }).expect(202);
    const onDemand = (await as(token).get('/api/valuations/as-of?date=2022-08-24').expect(200)).body;
    expect(onDemand.basis).toBe('ON_DEMAND');
    expect(onDemand.holdings).toEqual(snapshot.holdings);
    expect(onDemand.totals).toEqual(snapshot.totals);
    await job.runOnce(at('2022-08-27T09:00:00Z'));
  });

  it('values the 2020 boundary on demand: 43 then 215 shares, no ~80% cliff', async () => {
    await ds.query(`UPDATE transactions SET date = '2020-08-26' WHERE symbol = 'TSLA' AND quantity = 645`);
    await ds.query(`UPDATE transactions SET date = '2020-08-01' WHERE type = 'DEPOSIT'`);
    const fri = (await as(token).get('/api/valuations/as-of?date=2020-08-28&symbol=TSLA').expect(200)).body;
    const sat = (await as(token).get('/api/valuations/as-of?date=2020-08-29&symbol=TSLA').expect(200)).body;
    const mon = (await as(token).get('/api/valuations/as-of?date=2020-08-31&symbol=TSLA').expect(200)).body;
    expect(fri.holdings[0]).toMatchObject({ quantity: '43', marketValue: '95176.2', price: { close: '2213.4' }, split: { factor: '15', adjustedQuantity: '645', adjustedClose: '147.56' } });
    expect(sat.holdings[0]).toMatchObject({ quantity: '43', marketValue: '95176.2', price: { status: 'NON_TRADING_DAY' }, split: { factor: '15' } });
    expect(mon.holdings[0]).toMatchObject({ quantity: '215', marketValue: '107138.8', price: { close: '498.32' }, split: { factor: '3' } });
    expect(mon.holdings[0].price.note).toMatch(/TSLA split 5:1 on 2020-08-31 while held/);
    expect(Number(mon.holdings[0].marketValue) / Number(fri.holdings[0].marketValue)).toBeGreaterThan(1);
  });

  it('keeps lots and the portfolio in today\'s basis (the recorded quantities)', async () => {
    const lots = (await as(token).get(`/api/accounts/${broker.id}/lots?symbol=TSLA`).expect(200)).body.lots;
    expect(lots.map((l: { originalQuantity: string; originalCostBase: string }) => [l.originalQuantity, l.originalCostBase])).toEqual([
      ['645', '86430'],
      ['45', '10350'],
    ]);
  });

  it('never lets a provider overwrite a verified split', async () => {
    t.prices.addSplit('TSLA', { date: '2022-08-25', numerator: '2', denominator: '1' });
    await as(token).post('/api/valuations/recompute', { fromDate: '2022-08-20', refreshPrices: true }).expect(202);
    await job.runOnce(at('2022-08-27T10:00:00Z'));
    const splits = (await as(token).get('/api/stock-splits?symbol=TSLA').expect(200)).body.splits;
    expect(splits.find((s: { effectiveDate: string }) => s.effectiveDate === '2022-08-25')).toMatchObject({ numerator: '3', provenance: 'VERIFIED' });
  });

  it('applies a provider-reported split to trades recorded before it, and lets a later sale match them', async () => {
    const other = await t.token({ subject: 'splits-b' });
    const account = (await as(other).post('/api/accounts', { name: 'Live broker' }).expect(201)).body;
    const post = (body: Record<string, unknown>) => as(other).post(`/api/accounts/${account.id}/transactions`, body);
    await post({ type: 'DEPOSIT', date: '2025-06-02', currency: 'USD', amount: '10000' }).expect(201);
    const buy = (await post({ type: 'BUY', date: '2025-06-03', symbol: 'NEWS', currency: 'USD', quantity: '10', unitPrice: '100', fees: '0' }).expect(201)).body;
    // Recorded on the day it happened, before the split
    await ds.query(`UPDATE transactions SET created_at = '2025-06-03T15:00:00Z' WHERE id = $1`, [buy.id]);
    t.prices.setClose('NEWS', '2025-06-03', '100');
    t.prices.setClose('NEWS', '2025-06-04', '102');
    t.prices.setClose('NEWS', '2025-06-05', '51');
    t.prices.setClose('NEWS', '2025-06-06', '52');
    t.prices.addSplit('NEWS', { date: '2025-06-05', numerator: '2', denominator: '1' });
    await job.runOnce(at('2025-06-07T08:00:00Z'));

    const listed = (await as(other).get('/api/stock-splits?symbol=NEWS').expect(200)).body.splits;
    expect(listed).toEqual([expect.objectContaining({ effectiveDate: '2025-06-05', ratio: '2', provenance: 'PROVIDER', source: 'mock' })]);
    // The run that found the split already valued with it
    const days = (await as(other).get('/api/valuations?fromDate=2025-06-04&toDate=2025-06-05&include=holdings').expect(200)).body.days;
    expect(days.map((d: { holdings: Holding[] }) => [d.holdings[0].quantity, d.holdings[0].marketValue])).toEqual([
      ['10', '1020'],
      ['20', '1020'],
    ]);
    const lots = (await as(other).get(`/api/accounts/${account.id}/lots`).expect(200)).body.lots;
    expect(lots[0]).toMatchObject({ originalQuantity: '20', originalCostBase: '1000', unitCostBase: '50' });
    // A sale recorded after the split, in the new basis, matches the old lot
    await post({ type: 'SELL', date: '2025-06-06', symbol: 'NEWS', currency: 'USD', quantity: '20', unitPrice: '52', fees: '0' }).expect(201);
    const portfolio = (await as(other).get(`/api/accounts/${account.id}/portfolio`).expect(200)).body;
    expect(portfolio.holdings).toEqual([]);
  });

  it('reports a sale recorded before a later split in the same basis as its allocations', async () => {
    const other = await t.token({ subject: 'splits-c' });
    const account = (await as(other).post('/api/accounts', { name: 'Pre-split sale' }).expect(201)).body;
    const post = (body: Record<string, unknown>) => as(other).post(`/api/accounts/${account.id}/transactions`, body);
    await post({ type: 'DEPOSIT', date: '2025-06-02', currency: 'USD', amount: '10000' }).expect(201);
    const buy = (await post({ type: 'BUY', date: '2025-06-03', symbol: 'PRES', currency: 'USD', quantity: '10', unitPrice: '100', fees: '0' }).expect(201)).body;
    const sell = (await post({ type: 'SELL', date: '2025-06-04', symbol: 'PRES', currency: 'USD', quantity: '10', unitPrice: '110', fees: '0' }).expect(201)).body;
    await ds.query(`UPDATE transactions SET created_at = '2025-06-04T15:00:00Z' WHERE id IN ($1, $2)`, [buy.id, sell.id]);
    t.prices.setClose('PRES', '2025-06-03', '100');
    t.prices.setClose('PRES', '2025-06-04', '110');
    t.prices.setClose('PRES', '2025-06-05', '55');
    t.prices.addSplit('PRES', { date: '2025-06-05', numerator: '2', denominator: '1' });
    await job.runOnce(at('2025-06-07T08:00:00Z'));

    const body = (await as(other).get(`/api/transactions/${sell.id}/allocations`).expect(200)).body;
    expect(body.quantity).toBe('20');
    expect(body.unitPrice).toBe('55');
    expect(body.totals.quantity).toBe(body.quantity);
    expect(body.allocations.map((a: { quantity: string }) => a.quantity)).toEqual(['20']);
    expect(body.total).toBe('1100');
  });

  it('resolves an old ticker to its instrument\'s splits', async () => {
    await ds.query(`INSERT INTO security_symbol_aliases (symbol, instrument, note) VALUES ('TSLAOLD', 'TSLA', 'test alias')`);
    const body = (await as(token).get('/api/stock-splits?symbol=TSLAOLD').expect(200)).body;
    expect(body.instrument).toBe('TSLA');
    expect(body.splits).toHaveLength(2);
    expect(body.splits[0].symbols).toEqual(['TSLA', 'TSLAOLD']);
    expect((await as(token).get('/api/stock-splits/adjustment?symbol=TSLAOLD&date=2020-08-28').expect(200)).body.factor).toBe('15');
  });

  it('migrates down and back up, re-queuing valuations of split symbols', async () => {
    await undoMigrationsThrough(ds, 'StockSplits1762400000000');
    const [{ exists }] = await ds.query(`SELECT to_regclass('security_splits') IS NOT NULL AS exists`);
    expect(exists).toBe(false);
    await ds.query(`DELETE FROM valuation_recompute_requests`);
    await ds.runMigrations();
    const rows = await ds.query(`SELECT instrument, to_char(effective_date, 'YYYY-MM-DD') AS d, provenance FROM security_splits ORDER BY instrument, effective_date`);
    expect(rows).toEqual(
      expect.arrayContaining([
        { instrument: 'TSLA', d: '2020-08-31', provenance: 'VERIFIED' },
        { instrument: 'TSLA', d: '2022-08-25', provenance: 'VERIFIED' },
        // Splits the provider reported before are kept as PROVIDER rows
        { instrument: 'NEWS', d: '2025-06-05', provenance: 'PROVIDER' },
      ]),
    );
    const requests = await ds.query(`SELECT to_char(from_date, 'YYYY-MM-DD') AS d FROM valuation_recompute_requests WHERE account_id = $1`, [broker.id]);
    expect(requests).toEqual([{ d: '2020-08-26' }]);
  });
});
