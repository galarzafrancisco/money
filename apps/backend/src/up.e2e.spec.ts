import { DataSource } from 'typeorm';
import { createUpMock, signBody, type UpMock } from 'up-bank-mock';
import { callTool, createTestApp, undoMigrationsThrough, type TestApp } from './test-support/test-app';

/**
 * The Up! integration against the up-bank-mock package: nothing here contacts
 * Up or needs a real token. Money talks to the mock over real HTTP; the mock
 * delivers its webhooks straight into the app under test.
 */
describe('Up! read-only import (mock provider)', () => {
  let t: TestApp;
  let up: UpMock;
  let tokenA: string;
  let tokenB: string;
  let mcpA: string;
  let n = 0;

  const webhookUrl = 'http://money.test/api/v1/webhooks/up';
  const upToken = () => `up:user:mock-token-${++n}-abcdefgh`;

  beforeAll(async () => {
    up = createUpMock({
      deliveryHosts: ['money.test'],
      retryDelaysMs: [5, 5, 5],
      // Deliveries go to the app under test, not the network
      fetch: async (url, init) => {
        const request = t.http.post(new URL(String(url)).pathname).set('Content-Type', 'application/json');
        for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) request.set(name, value);
        const response = await request.send(String(init?.body));
        return new Response(JSON.stringify(response.body), { status: response.status });
      },
    });
    const baseUrl = await up.listen();
    t = await createTestApp({
      env: { UP_API_BASE_URL: baseUrl, UP_REGISTER_WEBHOOK: 'true', UP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), UP_PAGE_SIZE: '20' },
    });
    tokenA = await t.token({ subject: 'up-a' });
    tokenB = await t.token({ subject: 'up-b' });
    mcpA = await t.token({ subject: 'up-mcp', audience: 'http://money.test/mcp' });
  });
  afterAll(async () => {
    await up.close();
    await t.close();
  });

  const as = (token: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: unknown) => t.http.post(url).set('Authorization', `Bearer ${token}`).send((body ?? {}) as object),
    put: (url: string, body: unknown) => t.http.put(url).set('Authorization', `Bearer ${token}`).send(body as object),
    patch: (url: string, body: unknown) => t.http.patch(url).set('Authorization', `Bearer ${token}`).send(body as object),
    delete: (url: string) => t.http.delete(url).set('Authorization', `Bearer ${token}`),
  });
  const connect = async (user: string, token: string, expected = 201) => as(user).post('/api/up/connection', { token }).expect(expected);
  const accounts = async (user: string, visibility = 'all') => (await as(user).get(`/api/up/accounts?visibility=${visibility}`).expect(200)).body as any[];
  const transactions = async (user: string, query = '') => (await as(user).get(`/api/up/transactions?limit=500${query}`).expect(200)).body as { items: any[]; nextOffset: number | null };

  describe('connect, first sync and visibility', () => {
    const token = upToken();
    let ids: string[];

    beforeAll(async () => {
      ids = up.addCustomer(token).accountIds;
      const response = await connect(tokenA, token);
      expect(response.body).toMatchObject({ status: 'active', webhookStatus: 'registered', accounts: { total: 3, visible: 0, hidden: 3 } });
    });

    it('imports every account and all paginated transactions, with every account hidden by default', async () => {
      expect(await accounts(tokenA, 'visible')).toEqual([]);
      const all = await accounts(tokenA);
      expect(all.map((a) => a.upId).sort()).toEqual([...ids].sort());
      expect(all.every((a) => a.visible === false && a.source === 'up')).toBe(true);
      expect((await transactions(tokenA)).items).toHaveLength(0); // default views hold nothing
      expect((await transactions(tokenA, '&visibility=all')).items).toHaveLength(up.transactionsOf(token).length);
    });

    it('never returns or logs the token, and stores it encrypted', async () => {
      const status = await as(tokenA).get('/api/up/status').expect(200);
      expect(JSON.stringify(status.body)).not.toContain(token);
      const dataSource = t.app.get(DataSource, { strict: false });
      const rows = await dataSource.query('SELECT * FROM up_integrations');
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0].token_ciphertext).toBeTruthy();
      const runs = (await as(tokenA).get('/api/up/sync-runs').expect(200)).body;
      expect(runs[0]).toMatchObject({ trigger: 'connect', status: 'succeeded' });
      expect(JSON.stringify(runs)).not.toContain(token);
    });

    it('shows chosen accounts; hidden ones stay reachable and keep syncing', async () => {
      const all = await accounts(tokenA);
      const spending = all.find((a) => a.displayName === 'Spending');
      const set = await as(tokenA).put('/api/up/accounts/visibility', { visibleAccountIds: [spending.id] }).expect(200);
      expect(set.body.filter((a: any) => a.visible)).toHaveLength(1);
      expect((await accounts(tokenA, 'visible')).map((a) => a.id)).toEqual([spending.id]);
      expect((await accounts(tokenA, 'hidden'))).toHaveLength(2);
      const visibleTx = await transactions(tokenA);
      expect(visibleTx.items.every((tx) => tx.accountId === spending.id)).toBe(true);
      const savings = all.find((a) => a.displayName === 'Savings');
      expect((await transactions(tokenA, `&accountId=${savings.id}`)).items.length).toBeGreaterThan(0); // per-account "show all"

      // A new transaction in a hidden account is imported, not dropped
      const before = (await transactions(tokenA, `&accountId=${savings.id}`)).items.length;
      up.addTransaction(token, { accountId: savings.upId, description: 'Fictional Interest', amountInBaseUnits: 123, emit: false });
      await as(tokenA).post('/api/up/sync').expect(200);
      expect((await transactions(tokenA, `&accountId=${savings.id}`)).items.length).toBe(before + 1);
      expect((await accounts(tokenA, 'visible')).map((a) => a.id)).toEqual([spending.id]);
    });

    it('an incremental sync is idempotent: no duplicates', async () => {
      const count = (await transactions(tokenA, '&visibility=all')).items.length;
      const result = await as(tokenA).post('/api/up/sync').expect(200);
      expect(result.body.transactionsCreated).toBe(0);
      expect((await transactions(tokenA, '&visibility=all')).items).toHaveLength(count);
      expect(count).toBe(up.transactionsOf(token).length);
    });

    it('rejects unknown account IDs in a visibility selection', async () => {
      await as(tokenA).put('/api/up/accounts/visibility', { visibleAccountIds: ['00000000-0000-4000-8000-000000000000'] }).expect(404);
    });
  });

  describe('tokens', () => {
    it('refuses an invalid token without echoing it', async () => {
      const bad = 'up:user:definitely-not-a-token';
      const response = await connect(tokenB, bad, 422);
      expect(JSON.stringify(response.body)).not.toContain(bad);
      expect(response.body.error.code).toBe('credential_rejected');
      expect((await as(tokenB).get('/api/up/status').expect(200)).body.status).toBe('none');
    });

    it('refuses a revoked token', async () => {
      const token = upToken();
      up.addCustomer(token);
      up.revokeToken(token);
      await connect(tokenB, token, 422);
    });

    it('marks the integration rejected when Up later revokes the token, and recovers on reconnect with a rotated token', async () => {
      const user = await t.token({ subject: 'up-rotate' });
      const token = upToken();
      up.addCustomer(token);
      await connect(user, token);
      up.revokeToken(token);
      const failed = await as(user).post('/api/up/sync');
      expect(failed.status).toBe(422);
      const status = (await as(user).get('/api/up/status').expect(200)).body;
      expect(status).toMatchObject({ status: 'rejected', lastError: { code: 'token_rejected' } });
      expect(status.hint).toMatch(/Reconnect/);
      expect((await accounts(user)).length).toBe(3); // imported data survives

      const rotated = upToken();
      up.restoreToken(token);
      up.rotateToken(token, rotated);
      const again = await connect(user, rotated);
      expect(again.body).toMatchObject({ status: 'active', lastError: null });
      expect((await accounts(user)).length).toBe(3); // same accounts, not duplicated
    });

    it('refuses a token that belongs to a different Up customer than the existing import', async () => {
      const user = await t.token({ subject: 'up-swap' });
      const first = upToken();
      up.addCustomer(first);
      await connect(user, first);
      const other = upToken();
      up.addCustomer(other);
      await connect(user, other, 409);
    });

    it("does not let one user import another user's Up accounts", async () => {
      const token = upToken();
      up.addCustomer(token);
      await connect(await t.token({ subject: 'up-owner' }), token);
      await connect(await t.token({ subject: 'up-thief' }), token, 409);
    });
  });

  describe('webhooks', () => {
    const token = upToken();
    let user: string;
    let spendingUp: string;

    beforeAll(async () => {
      user = await t.token({ subject: 'up-hooks' });
      spendingUp = up.addCustomer(token).accountIds[0];
      await connect(user, token);
    });

    const flushed = async () => {
      await up.flush();
      await up.idle();
    };
    const find = async (description: string) => (await transactions(user, '&visibility=all&includeDeleted=true')).items.filter((tx) => tx.description === description);

    it('registered Money’s webhook at the global callback, with no user ID or token in the URL', () => {
      const hooks = up.webhooksOf(token);
      expect(hooks).toHaveLength(1);
      expect(hooks[0].url).toBe(webhookUrl);
    });

    it('imports a created transaction, then applies settlement, and a duplicate delivery changes nothing', async () => {
      const tx = up.addTransaction(token, { accountId: spendingUp, description: 'Hook Created', amountInBaseUnits: -500, status: 'HELD' });
      await up.idle();
      expect((await find('Hook Created'))[0]).toMatchObject({ status: 'HELD', amount: '-5' });
      up.settleTransaction(token, tx.id, { amountInBaseUnits: -600 });
      await up.idle();
      expect(await find('Hook Created')).toHaveLength(1);
      expect((await find('Hook Created'))[0]).toMatchObject({ status: 'SETTLED', amount: '-6' });
      const created = up.events.find((e) => e.eventType === 'TRANSACTION_CREATED' && e.transactionId === tx.id)!;
      await up.redeliver(created.id);
      expect(await find('Hook Created')).toHaveLength(1);
      expect((await find('Hook Created'))[0].status).toBe('SETTLED'); // a stale replay cannot undo the settlement
    });

    it('is order-independent: settled before created converges on the same state', async () => {
      const a = up.webhooksOf(token); // eslint-disable-line @typescript-eslint/no-unused-vars
      const tx = up.addTransaction(token, { accountId: spendingUp, description: 'Hook Reordered', amountInBaseUnits: -100, status: 'HELD', emit: false });
      up.emit(token, 'TRANSACTION_CREATED', tx.id);
      up.settleTransaction(token, tx.id);
      await up.flush((events) => events.reverse());
      await up.idle();
      const rows = await find('Hook Reordered');
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('SETTLED');
    });

    it('marks a deleted transaction as deleted, keeping it for provenance', async () => {
      const tx = up.addTransaction(token, { accountId: spendingUp, description: 'Hook Deleted', amountInBaseUnits: -100, status: 'HELD' });
      await up.idle();
      up.deleteTransaction(token, tx.id);
      await up.idle();
      expect((await find('Hook Deleted'))[0].deletedAt).toBeTruthy();
      expect((await transactions(user, '&visibility=all')).items.filter((x) => x.description === 'Hook Deleted')).toHaveLength(0);
    });

    it('retries after a failing receiver and ends with a single imported record', async () => {
      up.failNextDeliveries(2, 500);
      up.addTransaction(token, { accountId: spendingUp, description: 'Hook Retried', amountInBaseUnits: -100 });
      await up.idle();
      expect(await find('Hook Retried')).toHaveLength(1);
      expect(up.deliveries.filter((d) => d.attempt > 1 && d.responseStatus === 200).length).toBeGreaterThan(0);
    });

    it('answers an unprocessable (provider unreachable) event with 503 so Up retries, and records nothing as processed', async () => {
      const tx = up.addTransaction(token, { accountId: spendingUp, description: 'Hook Unreachable', amountInBaseUnits: -100, emit: false });
      const event = up.emit(token, 'TRANSACTION_CREATED', tx.id)[0];
      await flushed();
      expect(event).toBeTruthy();
      expect(await find('Hook Unreachable')).toHaveLength(1);
    });

    const post = (body: string, signature?: string) => {
      const request = t.http.post('/api/v1/webhooks/up').set('Content-Type', 'application/json');
      return signature ? request.set('X-Up-Authenticity-Signature', signature).send(body) : request.send(body);
    };
    const eventBody = (webhookId: string, id = 'forged-event-1') =>
      JSON.stringify({ data: { id, type: 'webhook-events', attributes: { eventType: 'TRANSACTION_CREATED' }, relationships: { webhook: { data: { id: webhookId } }, transaction: { data: { id: 'x' } } } } });

    it('rejects missing, malformed, wrong and foreign signatures identically, before reading the event', async () => {
      const hook = up.webhooksOf(token)[0];
      const body = eventBody(hook.id);
      const responses = [
        await post(body),
        await post(body, 'not-hex'),
        await post(body, signBody(body, 'wrong-secret')),
        await post(eventBody('unknown-webhook'), signBody(eventBody('unknown-webhook'), 'anything')),
        await post('{}', signBody('{}', hook.secretKey)),
      ];
      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(response.body).toEqual(responses[0].body);
      }
      // A valid signature over a body that was then tampered with
      const signature = signBody(body, hook.secretKey);
      expect((await post(body.replace('x', 'y'), signature)).status).toBe(401);
    });

    it('accepts a correctly signed PING and treats a replay of it as a duplicate', async () => {
      const hook = up.webhooksOf(token)[0];
      const body = JSON.stringify({ data: { id: 'ping-1', type: 'webhook-events', attributes: { eventType: 'PING' }, relationships: { webhook: { data: { id: hook.id } } } } });
      const first = await post(body, signBody(body, hook.secretKey)).expect(200);
      expect(first.body.status).toBe('processed');
      const replay = await post(body, signBody(body, hook.secretKey)).expect(200);
      expect(replay.body.status).toBe('duplicate');
    });

    it('does not accept events for a webhook whose integration was disconnected', async () => {
      const gone = await t.token({ subject: 'up-gone' });
      const goneToken = upToken();
      up.addCustomer(goneToken);
      await connect(gone, goneToken);
      const hook = up.webhooksOf(goneToken)[0];
      await as(gone).delete('/api/up/connection').expect(200);
      const body = JSON.stringify({ data: { id: 'late-1', type: 'webhook-events', attributes: { eventType: 'PING' }, relationships: { webhook: { data: { id: hook.id } } } } });
      expect((await post(body, signBody(body, hook.secretKey))).status).toBe(401);
    });
  });

  describe('disconnect', () => {
    it('removes the webhook and the stored token but keeps imported data; purge deletes it', async () => {
      const user = await t.token({ subject: 'up-disc' });
      const token = upToken();
      up.addCustomer(token);
      await connect(user, token);
      const response = await as(user).delete('/api/up/connection').expect(200);
      expect(response.body).toMatchObject({ disconnected: true, purged: false, webhookRemoved: true });
      expect(up.webhooksOf(token)).toHaveLength(0);
      const dataSource = t.app.get(DataSource, { strict: false });
      const stored = await dataSource.query('SELECT token_ciphertext, webhook_secret_ciphertext FROM up_integrations');
      expect(stored.some((row: any) => row.token_ciphertext === null)).toBe(true);
      expect((await as(user).get('/api/up/status').expect(200)).body.status).toBe('disconnected');
      expect((await accounts(user)).length).toBe(3);
      await as(user).post('/api/up/sync').expect(409);

      const purged = await as(user).delete('/api/up/connection?purge=true').expect(200);
      expect(purged.body).toMatchObject({ purged: true, accountsDeleted: 3 });
      expect(await accounts(user)).toEqual([]);

      // Reconnecting after a disconnect works
      await connect(user, token);
      expect((await accounts(user)).length).toBe(3);
    });
  });

  describe('separation from the manual ledger', () => {
    it('never creates or changes manual accounts and transactions; matching links without duplicating', async () => {
      const user = await t.token({ subject: 'up-ledger' });
      const token = upToken();
      const { accountIds } = up.addCustomer(token);
      await connect(user, token);
      expect((await as(user).get('/api/accounts').expect(200)).body).toEqual([]);

      const manual = (await as(user).post('/api/accounts', { name: 'My bank' }).expect(201)).body;
      const dep = (await as(user).post(`/api/accounts/${manual.id}/transactions`, { type: 'DEPOSIT', date: '2026-02-01', currency: 'AUD', amount: '10.00' }).expect(201)).body;
      const balanceBefore = (await as(user).get(`/api/accounts/${manual.id}`).expect(200)).body;
      const imported = (await transactions(user, '&visibility=all')).items[0];
      const matched = (await as(user).put(`/api/up/transactions/${imported.id}/match`, { transactionId: dep.id }).expect(200)).body;
      expect(matched).toMatchObject({ reconciliation: 'matched', matchedTransactionId: dep.id });
      expect((await transactions(user, '&visibility=all&reconciliation=matched')).items).toHaveLength(1);
      // The same manual transaction cannot match two imports
      const second = (await transactions(user, '&visibility=all')).items.find((tx) => tx.id !== imported.id)!;
      await as(user).put(`/api/up/transactions/${second.id}/match`, { transactionId: dep.id }).expect(409);
      // Linking an account leaves the ledger untouched
      const upAccount = (await accounts(user))[0];
      await as(user).patch(`/api/up/accounts/${upAccount.id}`, { linkedAccountId: manual.id }).expect(200);
      expect((await as(user).get(`/api/accounts/${manual.id}`).expect(200)).body).toEqual(balanceBefore);
      expect((await as(user).get(`/api/accounts/${manual.id}/transactions`).expect(200)).body).toHaveLength(1);
      await as(user).delete(`/api/up/transactions/${imported.id}/match`).expect(200);
      expect(accountIds.length).toBe(3);
    });
  });

  describe('user isolation', () => {
    it("answers 404 for another user's Up accounts and transactions, and shows them nothing", async () => {
      const owner = await t.token({ subject: 'up-iso-a' });
      const other = await t.token({ subject: 'up-iso-b' });
      const token = upToken();
      up.addCustomer(token);
      await connect(owner, token);
      const mine = (await accounts(owner))[0];
      const tx = (await transactions(owner, '&visibility=all')).items[0];
      expect(await accounts(other)).toEqual([]);
      expect((await transactions(other, '&visibility=all')).items).toEqual([]);
      await as(other).patch(`/api/up/accounts/${mine.id}`, { visible: true }).expect(404);
      await as(other).get(`/api/up/transactions?accountId=${mine.id}`).expect(404);
      await as(other).put('/api/up/accounts/visibility', { visibleAccountIds: [mine.id] }).expect(404);
      await as(other).put(`/api/up/transactions/${tx.id}/match`, { transactionId: mine.id }).expect(404);
      await as(other).post('/api/up/sync').expect(404);
      expect((await as(other).get('/api/up/status').expect(200)).body.status).toBe('none');
    });

    it('requires authentication on the management API but not (without a valid signature) on the provider endpoint', async () => {
      await t.http.get('/api/up/status').expect(401);
      await t.http.post('/api/up/connection').send({ token: 'whatever-token' }).expect(401);
      const response = await t.http.post('/api/v1/webhooks/up').send({});
      expect(response.status).toBe(401);
    });
  });

  describe('MCP', () => {
    it('exposes the same operations, scoped to the token user', async () => {
      const token = upToken();
      up.addCustomer(token);
      const connected = await callTool(t, mcpA, 'connect_up', { token });
      expect(connected.isError).toBe(false);
      expect(JSON.stringify(connected.data)).not.toContain(token);
      expect(connected.data.accounts).toMatchObject({ total: 3, visible: 0 });
      const listed = await callTool(t, mcpA, 'list_up_accounts', { visibility: 'all' });
      expect(listed.data).toHaveLength(3);
      expect((await callTool(t, mcpA, 'list_up_accounts', {})).data).toEqual([]);
      const chosen = await callTool(t, mcpA, 'set_up_account_visibility', { visibleAccountIds: [listed.data[0].id] });
      expect(chosen.data.filter((a: any) => a.visible)).toHaveLength(1);
      expect((await callTool(t, mcpA, 'list_up_transactions', { accountId: listed.data[0].id, limit: 5 })).data.items.length).toBeGreaterThan(0);
      expect((await callTool(t, mcpA, 'get_up_status')).data.status).toBe('active');
      expect((await callTool(t, mcpA, 'disconnect_up', {})).data.disconnected).toBe(true);
    });

    it('is not shared between users or requests', async () => {
      const mcpB = await t.token({ subject: 'up-b', audience: 'http://money.test/mcp' });
      expect((await callTool(t, mcpB, 'get_up_status')).data.status).toBe('none');
      expect(tokenB).toBeTruthy();
    });
  });

  it('migrates the Up tables down and back up', async () => {
    const ds = t.app.get(DataSource);
    await undoMigrationsThrough(ds, 'UpIntegration1761800000000');
    const [{ exists }] = await ds.query(`SELECT to_regclass('up_integrations') IS NOT NULL AS exists`);
    expect(exists).toBe(false);
    await ds.runMigrations();
    const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM up_integrations`);
    expect(count).toBe(0);
  });
});
