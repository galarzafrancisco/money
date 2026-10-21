import { createTestApp, type TestApp } from './test-support/test-app';

describe('concurrent changes to one account', () => {
  let t: TestApp;
  let token: string;

  beforeAll(async () => {
    t = await createTestApp();
    token = await t.token({ subject: 'racer' });
  });
  afterAll(() => t.close());

  it('serializes them, so two withdrawals cannot both spend the same cash', async () => {
    const account = (await t.http.post('/api/accounts').set('Authorization', `Bearer ${token}`).send({ name: 'Race' }).expect(201)).body;
    const url = `/api/accounts/${account.id}/transactions`;
    await t.http.post(url).set('Authorization', `Bearer ${token}`).send({ type: 'DEPOSIT', date: '2025-01-01', currency: 'AUD', amount: '100' }).expect(201);

    const attempts = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.http.post(url).set('Authorization', `Bearer ${token}`).send({ type: 'WITHDRAWAL', date: '2025-01-02', currency: 'AUD', amount: '60' }),
      ),
    );
    expect(attempts.map((r) => r.status).sort()).toEqual([201, 422, 422, 422, 422]);

    const portfolio = await t.http.get(`/api/accounts/${account.id}/portfolio?prices=false`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(portfolio.body.cash).toEqual([{ currency: 'AUD', balance: '40' }]);
    const rows = await t.http.get(url).set('Authorization', `Bearer ${token}`).expect(200);
    expect(rows.body.map((r: { sequence: number }) => r.sequence)).toEqual([1, 2]);
  });
});
