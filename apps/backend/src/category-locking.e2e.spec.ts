import { Client } from 'pg';
import type { Response } from 'supertest';
import { createTestApp, usingRealPostgres, type TestApp } from './test-support/test-app';

/**
 * Lock-ordering regressions between category deletion and the writers that
 * touch the same account rows. They need concurrent connections, so they only
 * run against a real Postgres server (TEST_POSTGRES_URL); PGlite is a single
 * session and serializes everything anyway.
 *
 * Each test forces the interleaving that used to deadlock: an outside
 * connection holds the account row, the requests queue up behind it in a
 * known order, and then the row is released.
 */
(usingRealPostgres ? describe : describe.skip)('category deletion racing account writes (Postgres)', () => {
  let t: TestApp;
  let token: string;
  let outside: Client;
  /** Separate from `outside`: pg_stat_activity is snapshotted per transaction, so it must be polled outside one */
  let monitor: Client;

  beforeAll(async () => {
    t = await createTestApp();
    token = await t.token({ subject: 'lock-racer' });
    if (t.config.database.driver !== 'postgres') throw new Error('expected a Postgres database');
    outside = new Client({ connectionString: t.config.database.url });
    await outside.connect();
    monitor = new Client({ connectionString: t.config.database.url });
    await monitor.connect();
  });
  afterAll(async () => {
    await outside?.end();
    await monitor?.end();
    await t?.close();
  });

  const auth = (r: ReturnType<TestApp['http']['get']>) => r.set('Authorization', `Bearer ${token}`);
  const create = async (path: string, body: object) => (await auth(t.http.post(path)).send(body).expect(201)).body;

  /** Waits until `count` backends of this database are waiting on a lock */
  async function waitForLockWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { rows } = await monitor.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (rows[0].n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${count} lock waiter(s)`);
  }

  /**
   * Holds the account row on the outside connection, starts `first` and waits
   * until it is blocked, then starts `second` and waits until it is blocked
   * too, then releases the row and returns both responses.
   */
  async function raceBehindAccountLock(
    accountId: string,
    first: () => PromiseLike<Response>,
    second: () => PromiseLike<Response>,
  ): Promise<[Response, Response]> {
    await outside.query('BEGIN');
    const started: Promise<Response>[] = [];
    try {
      await outside.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
      started.push(Promise.resolve(first()));
      await waitForLockWaiters(1);
      started.push(Promise.resolve(second()));
      await waitForLockWaiters(2);
    } finally {
      await outside.query('COMMIT');
    }
    const [a, b] = await Promise.all(started);
    return [a, b];
  }

  it('serializes assigning a category to an account against deleting that category', async () => {
    const category = await create('/api/categories', { name: 'doomed' });
    // Already assigned, so the delete's ON DELETE SET NULL has to update this account row
    const account = await create('/api/accounts', { name: 'Assign race', categoryId: category.id });

    // PATCH (a form save re-sending the category) queues on the account row first, then DELETE.
    // Previously PATCH then held the account and waited for the category's shared lock, while DELETE
    // held the category and waited for the account: Postgres aborted one of them with a deadlock (500).
    const [patched, deleted] = await raceBehindAccountLock(
      account.id,
      () => auth(t.http.patch(`/api/accounts/${account.id}`)).send({ name: 'Assign race (renamed)', categoryId: category.id }),
      () => auth(t.http.delete(`/api/categories/${category.id}?unassign=true`)),
    );
    expect(patched.status).toBe(200);
    expect(deleted.status).toBe(200);
    // The PATCH committed first, so the delete saw the assignment and cleared it
    expect(deleted.body.unassigned).toEqual({ accounts: 1, holdings: 0 });
    const after = await auth(t.http.get(`/api/accounts/${account.id}`)).expect(200);
    expect(after.body.categoryId).toBeNull();
  });

  it('serializes deleting an account against deleting a category assigned to it and its holding', async () => {
    const category = await create('/api/categories', { name: 'doomed-too' });
    const account = await create('/api/accounts', { name: 'Delete race', categoryId: category.id });
    await auth(t.http.put(`/api/accounts/${account.id}/holdings/TSLA/category`)).send({ categoryId: category.id }).expect(200);

    const [accountResult, categoryResult] = await raceBehindAccountLock(
      account.id,
      () => auth(t.http.delete(`/api/accounts/${account.id}`)),
      () => auth(t.http.delete(`/api/categories/${category.id}?unassign=true`)),
    );
    expect(accountResult.status).toBe(200);
    expect(categoryResult.status).toBe(200);
    await auth(t.http.get(`/api/accounts/${account.id}`)).expect(404);
    await auth(t.http.get(`/api/categories/${category.id}`)).expect(404);
  });
});
