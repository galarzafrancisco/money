import { dec } from '../common/decimal';
import { callTool, createTestApp, ISSUER, type TestApp } from '../test-support/test-app';
import { ValuationJobService } from '../valuations/valuation-job.service';
import { ALEX, SEED_USERS } from './seed-dataset';
import { SeedRefusedError, SeedRunner, type SeededUser } from './seed-runner';

/**
 * The synthetic seed data, written through the real services, gives the
 * balances, holdings and cost bases documented in apps/backend/docs/seed-data.md, keeps
 * users apart on REST and MCP, and never touches a non-synthetic record.
 */
const ANCHOR = '2026-06-30';

describe('synthetic seed data', () => {
  let test: TestApp;
  let runner: SeedRunner;
  let seeded: Record<string, SeededUser>;
  const tokenFor = (subject: string) => test.token({ subject });

  beforeAll(async () => {
    test = await createTestApp();
    runner = SeedRunner.fromApp(test.app);
    const result = await runner.reseed(ISSUER, ANCHOR, SEED_USERS.map((user) => ({ user })));
    seeded = Object.fromEntries(result.map((s) => [s.key, s]));
  });
  afterAll(() => test?.close());

  const portfolio = async (subject: string, accountId: string) => {
    const res = await test.http.get(`/api/accounts/${accountId}/portfolio`).set('Authorization', `Bearer ${await tokenFor(subject)}`);
    expect(res.status).toBe(200);
    return res.body;
  };
  const cashOf = (body: any) => Object.fromEntries(body.cash.map((c: any) => [c.currency, dec(c.balance).toFixed(2)]));
  const holdingsOf = (body: any) => Object.fromEntries(body.holdings.map((h: any) => [h.symbol, dec(h.quantity).toString()]));

  it('gives Alex the documented balances and holdings', async () => {
    const a = seeded.alex;
    const s = ALEX.subject;
    expect(cashOf(await portfolio(s, a.accounts.bank))).toEqual({ AUD: '24490.00' });
    expect(cashOf(await portfolio(s, a.accounts.emergency))).toEqual({ AUD: '15000.00' });
    expect(cashOf(await portfolio(s, a.accounts.term))).toEqual({ AUD: '10350.00' });

    const asx = await portfolio(s, a.accounts.asx);
    expect(cashOf(asx)).toEqual({ AUD: '5487.60' });
    expect(holdingsOf(asx)).toEqual({ 'BHP.AX': '15', 'CBA.AX': '30', 'VAS.AX': '35', 'VGS.AX': '15' });
    const vas = asx.holdings.find((h: any) => h.symbol === 'VAS.AX');
    // Specific identification took the 5 shares from the second lot
    expect(vas.lots.map((l: any) => dec(l.remainingQuantity).toString())).toEqual(['30', '5']);
    expect(dec(vas.costBase).toFixed(2)).toBe('15855.25');
    // FIFO: 20 of 50 CBA.AX sold, 30 left at 2785.50 × 30/50
    expect(dec(asx.holdings.find((h: any) => h.symbol === 'CBA.AX').costBase).toFixed(2)).toBe('1671.30');

    const us = await portfolio(s, a.accounts.us);
    expect(cashOf(us)).toEqual({ AUD: '0.00', USD: '2132.18' });
    expect(holdingsOf(us)).toEqual({ IVV: '25', NVDA: '25', PLTR: '30' });

    const sup = await portfolio(s, a.accounts.super);
    expect(cashOf(sup)).toEqual({ AUD: '966.40' });
    expect(holdingsOf(sup)).toEqual({ 'VDHG.AX': '30' });
  });

  it('gives Blair and the edge-case user the documented balances', async () => {
    const b = seeded.blair;
    expect(cashOf(await portfolio('money-seed-blair', b.accounts.bank))).toEqual({ AUD: '4000.00' });
    const asx = await portfolio('money-seed-blair', b.accounts.asx);
    expect(cashOf(asx)).toEqual({ AUD: '611.64' });
    expect(holdingsOf(asx)).toEqual({ 'A200.AX': '4', 'VAS.AX': '12' });

    const e = seeded.edge;
    const broker = await portfolio('money-seed-edge', e.accounts.broker);
    // 0.125 VOO × 276.92 = 34.615, settled as 34.62 cash
    expect(cashOf(broker)).toEqual({ USD: '2214.05' });
    expect(holdingsOf(broker)).toEqual({ 'DELIST.MOCKMISSING': '10', 'GRWTH.MOCKSTALE': '5', VOO: '0.125' });
    expect(cashOf(await portfolio('money-seed-edge', e.accounts.chf))).toEqual({ CHF: '1000.00' });
    expect(cashOf(await portfolio('money-seed-edge', e.accounts.l5))).toEqual({ AUD: '100.00' });
    expect((await portfolio('money-seed-edge', e.accounts.empty)).cash).toEqual([]);
  });

  it('dates the activity from the anchor', async () => {
    const res = await test.http.get(`/api/accounts/${seeded.alex.accounts.bank}/transactions`).set('Authorization', `Bearer ${await tokenFor(ALEX.subject)}`);
    expect(res.status).toBe(200);
    const dates = res.body.map((t: any) => t.date).sort();
    expect(dates[0]).toBe('2025-07-05'); // 360 days before the anchor
    expect(dates[dates.length - 1]).toBe('2026-05-31'); // 30 days before
  });

  it('keeps users apart on REST and MCP', async () => {
    const blair = await tokenFor('money-seed-blair');
    const list = await test.http.get('/api/accounts').set('Authorization', `Bearer ${blair}`);
    expect(list.body.map((a: any) => a.name).sort()).toEqual(['ASX Broker', 'Everyday Bank']);
    // Alex's account with the same name is another user's: 404, never 403
    const other = await test.http.get(`/api/accounts/${seeded.alex.accounts.bank}`).set('Authorization', `Bearer ${blair}`);
    expect(other.status).toBe(404);

    const mcpToken = (subject: string) => test.token({ subject, audience: test.config.auth.mcpResourceUrl });
    const tool = await callTool(test, await mcpToken(ALEX.subject), 'list_accounts');
    expect(tool.isError).toBe(false);
    expect(tool.data).toHaveLength(6);
    const blairTool = await callTool(test, await mcpToken('money-seed-blair'), 'get_portfolio', { accountId: seeded.alex.accounts.asx });
    expect(blairTool.isError).toBe(true);
    expect(JSON.stringify(blairTool.data)).toMatch(/not found/i);

    const empty = await test.http.get('/api/accounts').set('Authorization', `Bearer ${await tokenFor('money-seed-empty')}`);
    expect(empty.body).toEqual([]);
  });

  it('shows the edge cases: missing price, stale price, missing FX rate', async () => {
    // Stores closes, which the stale symbol's failing quote falls back to
    await test.app.get(ValuationJobService).runOnce(new Date(), { userId: seeded.edge.userId });
    const res = await test.http.get('/api/dashboard').set('Authorization', `Bearer ${await tokenFor('money-seed-edge')}`);
    expect(res.status).toBe(200);
    const tickers = Object.fromEntries(res.body.shares.tickers.map((t: any) => [t.symbol, t]));
    expect(tickers['DELIST.MOCKMISSING'].priceStatus).toBe('COST_FALLBACK');
    // The last stored close, served as stale. The dashboard still rates it MOCK, which outranks STALE.
    expect(tickers['GRWTH.MOCKSTALE'].price).toMatchObject({ isStale: true, isMock: true });
    expect(tickers.XYZ).toBeUndefined(); // sold out
    expect(res.body.fx.missing.map((m: any) => m.currency)).toContain('CHF');
    expect(res.body.valuation.status).toBe('PARTIAL');
  });

  it('reseeds to the same data', async () => {
    const again = await runner.reseed(ISSUER, ANCHOR, SEED_USERS.map((user) => ({ user })));
    const alex = again.find((s) => s.key === 'alex')!;
    expect(alex.userId).not.toBe(seeded.alex.userId);
    expect(cashOf(await portfolio(ALEX.subject, alex.accounts.asx))).toEqual({ AUD: '5487.60' });
    const list = await test.http.get('/api/accounts').set('Authorization', `Bearer ${await tokenFor(ALEX.subject)}`);
    expect(list.body).toHaveLength(6);
  });

  it('seeds and resets your own identity, keeping its user row', async () => {
    const [mine] = await runner.reseed(ISSUER, ANCHOR, [{ user: ALEX, subject: 'dev-person' }]);
    const token = await tokenFor('dev-person');
    expect((await test.http.get('/api/accounts').set('Authorization', `Bearer ${token}`)).body).toHaveLength(6);
    await runner.reset(ISSUER, [{ user: ALEX, subject: 'dev-person' }]);
    expect((await test.http.get('/api/accounts').set('Authorization', `Bearer ${token}`)).body).toEqual([]);
    const me = await test.http.get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.id).toBe(mine.userId);
  });

  it('refuses to touch an identity with records that are not synthetic', async () => {
    const token = await tokenFor('real-person');
    const created = await test.http.post('/api/accounts').set('Authorization', `Bearer ${token}`).send({ name: 'My real account' });
    expect(created.status).toBe(201);

    const target = [{ user: ALEX, subject: 'real-person' }];
    await expect(runner.reseed(ISSUER, ANCHOR, target)).rejects.toThrow(SeedRefusedError);
    await expect(runner.reset(ISSUER, target)).rejects.toThrow(/not synthetic seed data/);
    const list = await test.http.get('/api/accounts').set('Authorization', `Bearer ${token}`);
    expect(list.body.map((a: any) => a.name)).toEqual(['My real account']);
  });
});
