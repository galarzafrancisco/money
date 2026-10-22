import { DataSource } from 'typeorm';
import { daysBetween } from './market-prices/market-calendar';
import { callTool, createTestApp, type TestApp } from './test-support/test-app';
import { ValuationJobService, type RunSummary } from './valuations/valuation-job.service';
import { ValuationsService } from './valuations/valuations.service';

/**
 * Lifetime valuation history: an account with trades since April 2019 whose
 * snapshots only reach back to October 2025 (the old 366-day window) is
 * backfilled automatically, newest first, in batches, until the history runs
 * from the first purchase to the present. Mock closes, explicit "now"s.
 */
describe('automatic historical valuation backfill', () => {
  let t: TestApp;
  let job: ValuationJobService;
  let service: ValuationsService;
  let ds: DataSource;
  let token: string;
  let mcp: string;
  let user: { id: string; issuer: string; subject: string };
  let us: { id: string };
  let au: { id: string };

  const NOW = new Date('2026-01-15T08:00:00Z'); // Thursday: everything up to the 14th has closed
  const SETTLED = '2026-01-14';
  const FIRST_BUY = '2019-04-02';
  const BATCH = 500;
  const lifetimeDays = daysBetween(FIRST_BUY, SETTLED) + 1;

  const as = (path: string) => t.http.get(path).set('Authorization', `Bearer ${token}`);
  const record = (accountId: string, body: Record<string, unknown>) =>
    t.http.post(`/api/accounts/${accountId}/transactions`).set('Authorization', `Bearer ${token}`).send(body).expect(201);
  const status = () => service.status(user as never, NOW);
  const history = (query: Record<string, string>) => service.history(user as never, query as never, NOW);

  /** Runs the job until no due dates are left, as the scheduler's catch-up does */
  const drain = async (now = NOW): Promise<RunSummary[]> => {
    const runs: RunSummary[] = [];
    for (let i = 0; i < 30; i++) {
      const run = await job.runOnce(now);
      runs.push(run);
      if (!run.moreDue) return runs;
    }
    throw new Error('The backfill did not finish');
  };
  const computedBy = (runs: RunSummary[]) => runs.map((r) => r.users.find((u) => u.userId === user.id)?.datesComputed ?? 0);

  beforeAll(async () => {
    t = await createTestApp({ env: { VALUATION_MAX_DAYS_PER_RUN: String(BATCH) } });
    job = t.app.get(ValuationJobService);
    service = t.app.get(ValuationsService);
    ds = t.app.get(DataSource);
    token = await t.token({ subject: 'lifetime' });
    mcp = await t.token({ subject: 'lifetime', audience: 'http://money.test/mcp' });

    // As traded: 200 before VTI's 2:1 split on Monday 2022-06-06, 100 after
    t.prices.setClose('VTI', '2022-06-03', '200');
    t.prices.setClose('VTI', '2022-06-06', '100');
    t.prices.addSplit('VTI', { date: '2022-06-06', numerator: '2', denominator: '1' });
    t.prices.setClose('OLDCO', '2019-04-05', '21');

    us = (await t.http.post('/api/accounts').set('Authorization', `Bearer ${token}`).send({ name: 'US broker' }).expect(201)).body;
    au = (await t.http.post('/api/accounts').set('Authorization', `Bearer ${token}`).send({ name: 'ASX broker', reportingCurrency: 'AUD' }).expect(201)).body;
    await record(us.id, { type: 'DEPOSIT', date: '2019-04-01', currency: 'USD', amount: '50000' });
    await record(us.id, { type: 'BUY', date: FIRST_BUY, symbol: 'OLDCO', currency: 'USD', quantity: '10', unitPrice: '20', fees: '0' });
    await record(us.id, { type: 'BUY', date: '2020-01-06', symbol: 'VTI', currency: 'USD', quantity: '5', unitPrice: '150', fees: '0' });
    // A closed position: lifetime history still needs its closes up to the sale
    await record(us.id, { type: 'SELL', date: '2021-06-01', symbol: 'OLDCO', currency: 'USD', quantity: '10', unitPrice: '30', fees: '0' });
    await record(us.id, { type: 'WITHDRAWAL', date: '2023-02-01', currency: 'USD', amount: '1000' });
    await record(au.id, { type: 'DEPOSIT', date: '2019-05-01', currency: 'AUD', amount: '10000' });
    await record(au.id, { type: 'BUY', date: '2019-05-02', symbol: 'VAS.AX', currency: 'AUD', quantity: '3', unitPrice: '80', fees: '0' });
    const me = await ds.query(`SELECT id FROM users WHERE subject = 'lifetime'`);
    user = { id: me[0].id, issuer: 'https://taico.test', subject: 'lifetime' };

    // The state before this feature: snapshots only from October 2025
    await drain();
    await ds.query(`DELETE FROM valuation_days WHERE user_id = $1 AND valuation_date < '2025-10-01'`, [user.id]);
  });
  afterAll(() => t.close());

  it('detects the historical gap from the ledger', async () => {
    const before = await status();
    expect(before).toMatchObject({ earliestValuationDate: '2025-10-01', latestValuationDate: SETTLED });
    expect(before.coverage).toMatchObject({
      firstHoldingDate: FIRST_BUY,
      historyStartsOn: FIRST_BUY,
      historyLimitedByBackfillDays: false,
      requiredDays: lifetimeDays,
      missingDays: daysBetween(FIRST_BUY, '2025-09-30') + 1,
      backfillComplete: false,
    });
    const view = await history({ fromDate: '2019-01-01', toDate: SETTLED });
    expect(view.coverage).toMatchObject({ firstHoldingDate: FIRST_BUY, missingDays: before.coverage.missingDays, complete: false });
  });

  it('backfills newest first in batches, resumes after a crash, and never fetches stored closes again', async () => {
    const requestsBefore = t.prices.dailyCloseRequests.length;
    const first = await job.runOnce(NOW);
    expect(first.moreDue).toBe(true);
    expect(computedBy([first])).toEqual([BATCH]);
    // The most recent part of the gap comes first
    expect((await status()).earliestValuationDate).toBe('2024-05-19');

    // Another instance holds the lease: nothing happens, nothing is duplicated
    await ds.query(`UPDATE valuation_job_state SET lease_owner = 'other-pod', lease_expires_at = now() + interval '5 minutes' WHERE id = 1`);
    expect(await job.runOnce(NOW)).toMatchObject({ skipped: true, moreDue: false });
    // It crashed: its lease expires and the backfill carries on where it was
    await ds.query(`UPDATE valuation_job_state SET lease_expires_at = now() - interval '1 minute' WHERE id = 1`);
    const rest = await drain();
    expect(rest[rest.length - 1].moreDue).toBe(false);
    expect(computedBy(rest).reduce((a, b) => a + b, 0)).toBe(daysBetween(FIRST_BUY, '2025-09-30') + 1 - BATCH);
    expect(computedBy(rest).slice(0, -1).every((n) => n === BATCH)).toBe(true);

    // Every close was already stored by the first full history: only the open end is asked about again
    const asked = t.prices.dailyCloseRequests.slice(requestsBefore);
    expect(asked.every((r) => r.from >= '2026-01-01')).toBe(true);
  });

  it('serves a defensible lifetime series: complete, with historical quantities and closes', async () => {
    const after = await status();
    expect(after).toMatchObject({ earliestValuationDate: FIRST_BUY, latestValuationDate: SETTLED, materialisedDays: lifetimeDays, partialDays: 0 });
    expect(after.coverage).toMatchObject({ missingDays: 0, backfillComplete: true, percentComplete: 100 });

    const view = await history({ fromDate: '2019-01-01', toDate: SETTLED });
    expect(view.coverage).toMatchObject({ missingDays: 0, partialDays: 0, complete: true });
    expect(view.days.length).toBe(lifetimeDays);
    expect(view.days[0].date).toBe(FIRST_BUY);
    expect(view.days.every((d) => d.complete && !d.pendingRecompute)).toBe(true);

    const holdings = async (from: string, to: string) => (await history({ fromDate: from, toDate: to, include: 'holdings' })).days;
    const early = await holdings('2019-04-05', '2019-04-07');
    // Friday's close, then the weekend carried from it and labelled as such
    expect(early[0].holdings![0]).toMatchObject({ symbol: 'OLDCO', quantity: '10', costBase: '200', marketValue: '210', price: { status: 'CLOSE', close: '21' } });
    expect(early[1].holdings![0]).toMatchObject({ marketValue: '210', price: { status: 'NON_TRADING_DAY', tradingDate: '2019-04-05' } });
    expect(early[2].holdings![0].price.status).toBe('NON_TRADING_DAY');

    // The closed position is valued until it was sold, and not after
    const sale = await holdings('2021-05-31', '2021-06-01');
    expect(sale[0].holdings!.map((h) => h.symbol).sort()).toEqual(['OLDCO', 'VAS.AX', 'VTI']);
    expect(sale[1].holdings!.map((h) => h.symbol).sort()).toEqual(['VAS.AX', 'VTI']);

    // Closes as traded on each date (no later split applied backwards), quantities as recorded, the split flagged
    const split = await holdings('2022-06-03', '2022-06-06');
    const vti = (d: (typeof split)[number]) => d.holdings!.find((h) => h.symbol === 'VTI')!;
    expect(vti(split[0])).toMatchObject({ quantity: '5', marketValue: '1000', price: { close: '200', note: null } });
    expect(vti(split[3])).toMatchObject({ quantity: '5', marketValue: '500', price: { close: '100', note: expect.stringMatching(/split 2:1 on 2022-06-06, while held/) } });

    // Cash flows are not performance: a withdrawal changes no holding's value or cost base
    const cash = await history({ fromDate: '2023-01-31', toDate: '2023-02-01' });
    const usd = (i: number) => cash.days[i].totals.byCurrency.find((c) => c.currency === 'USD');
    expect(usd(1)!.costBase).toBe(usd(0)!.costBase);
    expect(usd(1)!.holdings).toBe(1);
  });

  it('converts old dates at their own historical FX close', async () => {
    const view = await history({ fromDate: '2019-05-02', toDate: '2019-05-05', baseCurrency: 'USD' });
    for (const d of view.days) {
      expect(d.totals.converted).not.toBeNull();
      const aud = d.totals.converted!.rates.find((r) => r.currency === 'AUD')!;
      expect(aud).toMatchObject({ kind: 'HISTORICAL', rate: '0.65' });
      expect(aud.tradingDate! <= d.date).toBe(true);
    }
  });

  it('re-values years of history after an old trade is imported, run by run, with a durable checkpoint', async () => {
    await record(us.id, { type: 'BUY', date: '2019-05-01', symbol: 'IMPORTED', currency: 'USD', quantity: '3', unitPrice: '10', fees: '0' });
    expect((await status()).pendingRecomputeFrom).toBe('2019-05-01');

    const first = await job.runOnce(NOW);
    expect(first.moreDue).toBe(true);
    // The checkpoint is stored with the request, so a restart resumes it rather than starting over
    const [checkpoint] = await ds.query(
      `SELECT to_char(recomputed_from, 'YYYY-MM-DD') AS recomputed_from, checkpoint_for = requested_at AS current FROM valuation_recompute_requests WHERE account_id = $1`,
      [us.id],
    );
    // The newest 500 dates are done: 2024-09-02 to 2026-01-14
    expect(checkpoint).toEqual({ recomputed_from: '2024-09-02', current: true });
    let view = await history({ fromDate: '2024-09-01', toDate: '2024-09-02' });
    expect(view.days.map((d) => d.pendingRecompute)).toEqual([true, false]);

    const rest = await drain();
    expect([first, ...rest].reduce((n, r) => n + (r.users.find((u) => u.userId === user.id)?.datesComputed ?? 0), 0)).toBe(daysBetween('2019-05-01', SETTLED) + 1);
    expect((await status()).pendingRecomputeFrom).toBeNull();
    view = await history({ fromDate: '2019-05-01', toDate: SETTLED, include: 'totals' });
    expect(view.days.every((d) => !d.pendingRecompute)).toBe(true);
    for (const date of ['2019-05-01', SETTLED]) {
      const day = (await history({ fromDate: date, toDate: date, include: 'holdings' })).days[0];
      expect(day.holdings!.find((h) => h.symbol === 'IMPORTED')).toMatchObject({ quantity: '3', costBase: '30' });
    }
  });

  it('starts over when a request is renewed mid-way', async () => {
    await record(us.id, { type: 'BUY', date: '2020-02-03', symbol: 'IMPORTED', currency: 'USD', quantity: '1', unitPrice: '10', fees: '0' });
    await job.runOnce(NOW);
    // Renewed before the next run: the old checkpoint no longer counts
    await record(us.id, { type: 'BUY', date: '2025-12-01', symbol: 'IMPORTED', currency: 'USD', quantity: '1', unitPrice: '10', fees: '0' });
    const [request] = await service['repo'].recomputeRequests(user.id);
    expect(request.recomputedFrom).toBeNull();
    expect(request.fromDate <= '2020-02-03').toBe(true);
    await drain();
    const latest = (await history({ fromDate: SETTLED, toDate: SETTLED, include: 'holdings' })).days[0];
    expect(latest.holdings!.find((h) => h.symbol === 'IMPORTED')!.quantity).toBe('5');
  });

  it('records an outage in old history as missing prices and heals it on a later retry', async () => {
    t.prices.setFailing('GAPCO');
    await record(us.id, { type: 'BUY', date: '2019-06-03', symbol: 'GAPCO', currency: 'USD', quantity: '1', unitPrice: '10', fees: '0' });
    await record(us.id, { type: 'SELL', date: '2019-06-10', symbol: 'GAPCO', currency: 'USD', quantity: '1', unitPrice: '10', fees: '0' });
    await drain();
    let s = await status();
    expect(s.coverage.partialDays).toBe(7);
    expect(s.coverage.backfillComplete).toBe(true);
    expect(s.missingPrices).toEqual([{ symbol: 'GAPCO', days: 7, firstDate: '2019-06-03', lastDate: '2019-06-09' }]);
    const gap = await history({ fromDate: '2019-06-03', toDate: '2019-06-03', include: 'holdings' });
    expect(gap.days[0].complete).toBe(false);
    expect(gap.days[0].holdings!.find((h) => h.symbol === 'GAPCO')).toMatchObject({ marketValue: null, price: { status: 'MISSING' } });

    // Provider back. Old PARTIAL days wait for VALUATION_PARTIAL_RETRY_DAYS, then are retried at low priority
    t.prices.setFailing('GAPCO', false);
    expect(computedBy(await drain())).toEqual([0]);
    await ds.query(`UPDATE valuation_days SET computed_at = computed_at - interval '8 days' WHERE user_id = $1 AND status = 'PARTIAL'`, [user.id]);
    expect(computedBy(await drain())).toEqual([7]);
    s = await status();
    expect(s.coverage.partialDays).toBe(0);
    expect(s.missingPrices).toEqual([]);
  });

  it('looks a closed historical position up only over the dates it was held', async () => {
    const requestsBefore = t.prices.dailyCloseRequests.length;
    await record(us.id, { type: 'BUY', date: '2019-07-01', symbol: 'SHORTCO', currency: 'USD', quantity: '2', unitPrice: '10', fees: '0' });
    await record(us.id, { type: 'SELL', date: '2019-07-15', symbol: 'SHORTCO', currency: 'USD', quantity: '2', unitPrice: '12', fees: '0' });
    await drain();

    const asked = t.prices.dailyCloseRequests.slice(requestsBefore).filter((r) => r.symbol === 'SHORTCO');
    expect(asked.length).toBeGreaterThan(0);
    // Last held 2019-07-14; only the carry window (7 days) past it, not the years to today
    expect(asked.every((r) => r.from >= '2019-06-24' && r.to <= '2019-07-21')).toBe(true);
    // Still a complete valuation for every day it was held, weekend included
    const held = await history({ fromDate: '2019-07-01', toDate: '2019-07-14', include: 'holdings' });
    expect(held.days.every((d) => d.complete)).toBe(true);
    expect(held.days.every((d) => d.holdings!.some((h) => h.symbol === 'SHORTCO' && h.marketValue !== null))).toBe(true);
  });

  it('recomputes deterministically: the same ledger and closes give the same figures', async () => {
    const strip = (days: Awaited<ReturnType<typeof history>>['days']) => days.map(({ computedAt: _computedAt, ...rest }) => rest);
    const before = strip((await history({ fromDate: '2020-01-01', toDate: '2020-03-31', include: 'holdings' })).days);
    await t.http.post('/api/valuations/recompute').set('Authorization', `Bearer ${token}`).send({ fromDate: '2019-01-01' }).expect(202);
    await drain();
    const after = strip((await history({ fromDate: '2020-01-01', toDate: '2020-03-31', include: 'holdings' })).days);
    expect(after).toEqual(before);
  });

  it('shows the coverage over REST and MCP', async () => {
    const rest = (await as('/api/valuations/status').expect(200)).body;
    expect(rest.coverage).toMatchObject({ firstHoldingDate: FIRST_BUY, historyStartsOn: FIRST_BUY });
    expect(rest.missingPrices).toEqual([]);
    const viaMcp = await callTool(t, mcp, 'get_valuation_status', {});
    expect(viaMcp.data).toMatchObject({ coverage: { firstHoldingDate: FIRST_BUY } });
    const hist = (await as('/api/valuations?fromDate=2019-04-01&toDate=2019-04-30').expect(200)).body;
    expect(hist.coverage).toMatchObject({ firstHoldingDate: FIRST_BUY });
  });
});
