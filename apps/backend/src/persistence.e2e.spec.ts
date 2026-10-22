import { createTestApp, type TestApp } from './test-support/test-app';

// Production keeps its data in PostgreSQL, outside the pod. A restart or
// redeploy boots a new app on the same database: startup migrations must find
// the schema already in place, and every record must still be there, still
// isolated per user.
describe('persistence across an app restart', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const as = (token: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: unknown) => t.http.post(url).set('Authorization', `Bearer ${token}`).send(body as object),
  });

  it('keeps users, accounts and transactions, and reruns migrations as a no-op', async () => {
    const tokenA = await t.token({ subject: 'user-a' });
    const tokenB = await t.token({ subject: 'user-b' });
    const me = (await as(tokenA).get('/api/me').expect(200)).body;
    const account = (await as(tokenA).post('/api/accounts', { name: 'Broker', reportingCurrency: 'AUD' }).expect(201)).body;
    await as(tokenA).post(`/api/accounts/${account.id}/transactions`, { type: 'DEPOSIT', date: '2025-01-02', currency: 'AUD', amount: '1234.5' }).expect(201);

    await t.restart();

    await t.http.get('/health').expect(200, { status: 'ok' });
    const meAgain = (await as(tokenA).get('/api/me').expect(200)).body;
    expect(meAgain.id).toBe(me.id);
    const accounts = (await as(tokenA).get('/api/accounts').expect(200)).body;
    expect(accounts).toEqual([expect.objectContaining({ id: account.id, name: 'Broker', reportingCurrency: 'AUD' })]);
    const portfolio = (await as(tokenA).get(`/api/accounts/${account.id}/portfolio?prices=false`).expect(200)).body;
    expect(portfolio.cash).toEqual([{ currency: 'AUD', balance: '1234.5' }]);
    // Still another user's resource after the restart
    await as(tokenB).get(`/api/accounts/${account.id}`).expect(404);

    // The restarted app can write too
    await as(tokenA).post(`/api/accounts/${account.id}/transactions`, { type: 'WITHDRAWAL', date: '2025-01-03', currency: 'AUD', amount: '234.5' }).expect(201);
    const after = (await as(tokenA).get(`/api/accounts/${account.id}/portfolio?prices=false`).expect(200)).body;
    expect(after.cash).toEqual([{ currency: 'AUD', balance: '1000' }]);
  });
});
