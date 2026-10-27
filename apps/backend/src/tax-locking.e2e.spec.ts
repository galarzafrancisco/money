import { Client } from 'pg';
import type { Response } from 'supertest';
import { createTestApp, usingRealPostgres, type TestApp } from './test-support/test-app';

/**
 * A tax item moving between financial years while another write to it waits.
 * Item writers lock the item's year first, but they learn which year from an
 * unlocked read, so a move that commits while they wait changes the year
 * under them. These tests force that interleaving against real Postgres
 * (TEST_POSTGRES_URL); PGlite is a single session and serializes everything.
 *
 * An outside connection holds 2025-26's year row, the request reads the item
 * there and queues behind it, and the outside transaction then moves the item
 * to 2026-27 (filing that year, for most cases) before it commits.
 */
(usingRealPostgres ? describe : describe.skip)('tax item writes racing a move to another year (Postgres)', () => {
  let t: TestApp;
  let token: string;
  let userId: string;
  let outside: Client;
  let monitor: Client;

  beforeAll(async () => {
    t = await createTestApp();
    token = await t.token({ subject: 'tax-lock-racer' });
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

  async function waitForLockWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { rows } = await monitor.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
      if (rows[0].n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${count} lock waiter(s)`);
  }

  async function yearRow(startYear: number, status: string): Promise<void> {
    await outside.query(
      `INSERT INTO tax_returns (id, user_id, jurisdiction, start_year, status) VALUES (gen_random_uuid(), $1, 'AU', $2, $3)
       ON CONFLICT (user_id, jurisdiction, start_year) DO UPDATE SET status = EXCLUDED.status`,
      [userId, startYear, status],
    );
  }

  /** A fresh item in 2025-26, with both years back to PREPARING */
  async function freshItem(description: string): Promise<string> {
    const item = (await auth(t.http.post('/api/tax/items')).send({ description, taxYear: '2025-26', amount: '100' }).expect(201)).body;
    userId ??= (await outside.query('SELECT user_id FROM tax_items WHERE id = $1', [item.id])).rows[0].user_id;
    await yearRow(2025, 'PREPARING');
    await yearRow(2026, 'PREPARING');
    return item.id;
  }

  /**
   * Holds 2025-26 on the outside connection, starts `request` and waits until
   * it is blocked there, then moves the item to 2026-27 (and files that year
   * when `fileTarget`) and commits.
   */
  async function raceAgainstMove(itemId: string, fileTarget: boolean, request: () => PromiseLike<Response>): Promise<Response> {
    await outside.query('BEGIN');
    let started: Promise<Response>;
    try {
      await outside.query(`SELECT id FROM tax_returns WHERE user_id = $1 AND start_year = 2025 FOR UPDATE`, [userId]);
      started = Promise.resolve(request());
      await waitForLockWaiters(1);
      await outside.query('UPDATE tax_items SET start_year = 2026 WHERE id = $1', [itemId]);
      if (fileTarget) await yearRow(2026, 'FILED');
    } finally {
      await outside.query('COMMIT');
    }
    return started;
  }

  const startYearOf = async (itemId: string) => (await outside.query('SELECT start_year FROM tax_items WHERE id = $1', [itemId])).rows[0]?.start_year;

  it('an edit that lands after the item moved into a filed year is refused, and does not move it back', async () => {
    const id = await freshItem('Edit race');
    const res = await raceAgainstMove(id, true, () => auth(t.http.patch(`/api/tax/items/${id}`)).send({ amount: '200' }));
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('2026-27 is filed');
    expect(await startYearOf(id)).toBe(2026);
    expect((await outside.query('SELECT amount FROM tax_items WHERE id = $1', [id])).rows[0].amount).toBe('100.0000000000');
  });

  it('an edit without a taxYear keeps the item in the year it moved to', async () => {
    const id = await freshItem('Stay race');
    const res = await raceAgainstMove(id, false, () => auth(t.http.patch(`/api/tax/items/${id}`)).send({ amount: '200' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ taxYear: '2026-27', amount: '200.00' });
    expect(await startYearOf(id)).toBe(2026);
  });

  it('a delete that lands after the item moved into a filed year is refused', async () => {
    const id = await freshItem('Delete race');
    const res = await raceAgainstMove(id, true, () => auth(t.http.delete(`/api/tax/items/${id}`)));
    expect(res.status).toBe(409);
    expect(await startYearOf(id)).toBe(2026);
  });

  it('linking a transaction or evidence after the item moved into a filed year is refused', async () => {
    const account = (await auth(t.http.post('/api/accounts')).send({ name: 'Race bank', type: 'CASH', reportingCurrency: 'AUD' }).expect(201)).body;
    const tx = (await auth(t.http.post(`/api/accounts/${account.id}/transactions`)).send({ type: 'DEPOSIT', date: '2026-01-05', currency: 'AUD', amount: '100' }).expect(201)).body;

    const linked = await freshItem('Link race');
    const link = await raceAgainstMove(linked, true, () => auth(t.http.post('/api/tax/links')).send({ itemId: linked, transactionId: tx.id }));
    expect(link.status).toBe(409);
    expect((await outside.query('SELECT count(*)::int AS n FROM tax_source_links WHERE item_id = $1', [linked])).rows[0].n).toBe(0);

    const evidenced = await freshItem('Evidence race');
    const evidence = await raceAgainstMove(evidenced, true, () => auth(t.http.post('/api/tax/evidence')).send({ itemId: evidenced, label: 'Receipt', url: 'https://example.com/r.pdf' }));
    expect(evidence.status).toBe(409);
    expect((await outside.query('SELECT count(*)::int AS n FROM tax_evidence_links WHERE item_id = $1', [evidenced])).rows[0].n).toBe(0);
  });

  it('filing the target year while a move waits: the move is refused once it sees the filed year', async () => {
    const id = await freshItem('Move race');
    // The request moves the item 2025-26 → 2026-27; the outside transaction files 2026-27 before letting it through
    await outside.query('BEGIN');
    let started: Promise<Response>;
    try {
      await outside.query(`SELECT id FROM tax_returns WHERE user_id = $1 AND start_year = 2025 FOR UPDATE`, [userId]);
      started = Promise.resolve(auth(t.http.patch(`/api/tax/items/${id}`)).send({ taxYear: '2026-27' }));
      await waitForLockWaiters(1);
      await yearRow(2026, 'FILED');
    } finally {
      await outside.query('COMMIT');
    }
    expect((await started).status).toBe(409);
    expect(await startYearOf(id)).toBe(2025);
  });
});
