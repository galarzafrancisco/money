import { callTool, createTestApp, usingRealPostgres, type TestApp } from './test-support/test-app';

describe('transfers between accounts', () => {
  let t: TestApp;
  let tokenA: string;
  let tokenB: string;
  let mcpA: string;

  beforeAll(async () => {
    t = await createTestApp();
    tokenA = await t.token({ subject: 'transfer-a' });
    tokenB = await t.token({ subject: 'transfer-b' });
    mcpA = await t.token({ subject: 'transfer-a', audience: 'http://money.test/mcp' });
  });
  afterAll(() => t.close());

  const as = (token: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: unknown) => t.http.post(url).set('Authorization', `Bearer ${token}`).send(body as object),
    patch: (url: string, body: unknown) => t.http.patch(url).set('Authorization', `Bearer ${token}`).send(body as object),
    delete: (url: string) => t.http.delete(url).set('Authorization', `Bearer ${token}`),
  });

  let counter = 0;
  const account = async (token: string, extra: Record<string, unknown> = {}) =>
    (await as(token).post('/api/accounts', { name: `Account ${++counter}`, ...extra }).expect(201)).body as { id: string };
  const deposit = (token: string, accountId: string, currency: string, amount: string, date = '2025-01-01') =>
    as(token).post(`/api/accounts/${accountId}/transactions`, { type: 'DEPOSIT', date, currency, amount }).expect(201);
  const cash = async (token: string, accountId: string) =>
    Object.fromEntries(
      ((await as(token).get(`/api/accounts/${accountId}/portfolio?prices=false`).expect(200)).body.cash as { currency: string; balance: string }[]).map(
        (c) => [c.currency, c.balance],
      ),
    );
  const transactions = async (token: string, accountId: string) =>
    (await as(token).get(`/api/accounts/${accountId}/transactions`).expect(200)).body as Record<string, unknown>[];

  describe('same currency', () => {
    it('debits the source and credits the destination with linked legs', async () => {
      const bank = await account(tokenA);
      const bucket = await account(tokenA, { parentAccountId: bank.id });
      await deposit(tokenA, bank.id, 'AUD', '10000');

      const response = await as(tokenA)
        .post('/api/transfers', { fromAccountId: bank.id, toAccountId: bucket.id, date: '2025-02-01', fromCurrency: 'aud', fromAmount: '2500.50', fees: '1.5', description: 'TD' })
        .expect(201);
      const transfer = response.body;
      expect(transfer).toMatchObject({
        fromAccountId: bank.id, toAccountId: bucket.id, date: '2025-02-01', description: 'TD',
        fromCurrency: 'AUD', fromAmount: '2500.5', toCurrency: 'AUD', toAmount: '2500.5', rate: '1', fees: '1.5', isFx: false, calculatedField: 'toAmount',
      });

      expect(await cash(tokenA, bank.id)).toEqual({ AUD: '7498' });
      expect(await cash(tokenA, bucket.id)).toEqual({ AUD: '2500.5' });

      const out = (await transactions(tokenA, bank.id)).find((row) => row.type === 'TRANSFER_OUT');
      expect(out).toMatchObject({ id: transfer.outTransactionId, transferId: transfer.id, counterpartyAccountId: bucket.id, currency: 'AUD', amount: '2500.5', fees: '1.5' });
      const into = (await transactions(tokenA, bucket.id)).find((row) => row.type === 'TRANSFER_IN');
      expect(into).toMatchObject({ id: transfer.inTransactionId, transferId: transfer.id, counterpartyAccountId: bank.id, currency: 'AUD', amount: '2500.5' });

      // The tree report counts the money once: the parent's rolled-up AUD is unchanged except for the fee
      const report = (await as(tokenA).get(`/api/reports/accounts?rootAccountId=${bank.id}&valuation=cost`).expect(200)).body;
      expect(JSON.stringify(report.totals)).toContain('9998.5');

      await as(tokenA).get(`/api/transfers/${transfer.id}`).expect(200);
      const filtered = await as(tokenA).get(`/api/transfers?accountId=${bucket.id}`).expect(200);
      expect(filtered.body.map((row: { id: string }) => row.id)).toEqual([transfer.id]);
    });

    it('rejects transfers the source cannot fund on that date, writing nothing', async () => {
      const from = await account(tokenA);
      const to = await account(tokenA);
      await deposit(tokenA, from.id, 'AUD', '100', '2025-03-01');

      const early = await as(tokenA).post('/api/transfers', { fromAccountId: from.id, toAccountId: to.id, date: '2025-02-28', fromCurrency: 'AUD', fromAmount: '50' }).expect(422);
      expect(early.body.error).toMatchObject({ code: 'ledger_violation', details: { side: 'source', accountId: from.id, currency: 'AUD' } });
      const withFees = await as(tokenA).post('/api/transfers', { fromAccountId: from.id, toAccountId: to.id, date: '2025-03-02', fromCurrency: 'AUD', fromAmount: '100', fees: '0.01' }).expect(422);
      expect(withFees.body.error.details).toMatchObject({ required: '100.01', available: '100' });
      const otherCurrency = await as(tokenA).post('/api/transfers', { fromAccountId: from.id, toAccountId: to.id, date: '2025-03-02', fromCurrency: 'USD', fromAmount: '1' }).expect(422);
      expect(otherCurrency.body.error.details.currency).toBe('USD');

      expect(await transactions(tokenA, to.id)).toEqual([]);
      expect((await transactions(tokenA, from.id)).length).toBe(1);
      expect((await as(tokenA).get(`/api/transfers?accountId=${from.id}`).expect(200)).body).toEqual([]);
    });

    it('validates input', async () => {
      const from = await account(tokenA);
      const to = await account(tokenA);
      await deposit(tokenA, from.id, 'AUD', '100');
      const post = (body: Record<string, unknown>) =>
        as(tokenA).post('/api/transfers', { fromAccountId: from.id, toAccountId: to.id, date: '2025-02-01', fromCurrency: 'AUD', ...body });

      expect((await post({ toAccountId: from.id, fromAmount: '1' }).expect(400)).body.error.message).toMatch(/different accounts/);
      expect((await post({}).expect(400)).body.error.message).toMatch(/fromAmount/);
      expect((await post({ fromAmount: '10', toAmount: '9' }).expect(400)).body.error.message).toMatch(/must equal fromAmount/);
      expect((await post({ fromAmount: '10', rate: '0.5' }).expect(400)).body.error.message).toMatch(/rate 1/);
      await post({ fromAmount: '-5' }).expect(400);
      await post({ fromAmount: '0' }).expect(400);
      await post({ fromAmount: '1', fees: '-1' }).expect(400);
      await post({ fromAmount: '1', date: '2025-02-30' }).expect(400);
      await post({ fromAmount: '1', toAccountId: 'not-a-uuid' }).expect(404);
    });

    it('cannot be recorded or changed leg by leg through the transactions API', async () => {
      const from = await account(tokenA);
      const to = await account(tokenA);
      await deposit(tokenA, from.id, 'AUD', '100');
      await as(tokenA).post(`/api/accounts/${from.id}/transactions`, { type: 'TRANSFER_OUT', date: '2025-02-01', currency: 'AUD', amount: '1' }).expect(400);

      const transfer = (await as(tokenA).post('/api/transfers', { fromAccountId: from.id, toAccountId: to.id, date: '2025-02-01', fromCurrency: 'AUD', fromAmount: '40' }).expect(201)).body;
      for (const legId of [transfer.outTransactionId, transfer.inTransactionId]) {
        const patch = await as(tokenA).patch(`/api/transactions/${legId}`, { amount: '1' }).expect(409);
        expect(patch.body.error.details).toEqual({ transferId: transfer.id });
        await as(tokenA).delete(`/api/transactions/${legId}`).expect(409);
        await as(tokenA).get(`/api/transactions/${legId}`).expect(200);
      }
      const typed = await as(tokenA).get(`/api/accounts/${to.id}/transactions?type=TRANSFER_IN`).expect(200);
      expect(typed.body.map((row: { id: string }) => row.id)).toEqual([transfer.inTransactionId]);
    });
  });

  describe('between currencies', () => {
    it('records explicit FX details and credits the destination in its currency', async () => {
      const aud = await account(tokenA);
      const usd = await account(tokenA, { reportingCurrency: 'USD' });
      await deposit(tokenA, aud.id, 'AUD', '5000');

      const byRate = (await as(tokenA)
        .post('/api/transfers', { fromAccountId: aud.id, toAccountId: usd.id, date: '2025-02-01', fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: '1000', rate: '0.6543', fees: '5' })
        .expect(201)).body;
      expect(byRate).toMatchObject({ fromAmount: '1000', toAmount: '654.3', rate: '0.6543', fees: '5', isFx: true, calculatedField: 'toAmount' });

      const byAmounts = (await as(tokenA)
        .post('/api/transfers', { fromAccountId: aud.id, toAccountId: usd.id, date: '2025-02-02', fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: '300', toAmount: '200' })
        .expect(201)).body;
      expect(byAmounts).toMatchObject({ rate: '0.6666666667', calculatedField: 'rate' });

      const byTarget = (await as(tokenA)
        .post('/api/transfers', { fromAccountId: aud.id, toAccountId: usd.id, date: '2025-02-03', fromCurrency: 'AUD', toCurrency: 'USD', toAmount: '65', rate: '0.65' })
        .expect(201)).body;
      expect(byTarget).toMatchObject({ fromAmount: '100', calculatedField: 'fromAmount' });

      expect(await cash(tokenA, aud.id)).toEqual({ AUD: '3595' });
      expect(await cash(tokenA, usd.id)).toEqual({ USD: '919.3' });

      await as(tokenA)
        .post('/api/transfers', { fromAccountId: aud.id, toAccountId: usd.id, date: '2025-02-03', fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: '100' })
        .expect(400);
      await as(tokenA)
        .post('/api/transfers', { fromAccountId: aud.id, toAccountId: usd.id, date: '2025-02-03', fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: '100', toAmount: '70', rate: '0.65' })
        .expect(400);
    });
  });

  describe('edits and deletion', () => {
    it('edits both legs together and recalculates the calculated field', async () => {
      const from = await account(tokenA);
      const to = await account(tokenA);
      await deposit(tokenA, from.id, 'AUD', '1000');
      const transfer = (await as(tokenA).post('/api/transfers', { fromAccountId: from.id, toAccountId: to.id, date: '2025-02-01', fromCurrency: 'AUD', fromAmount: '100' }).expect(201)).body;

      const bigger = (await as(tokenA).patch(`/api/transfers/${transfer.id}`, { fromAmount: '250', fees: '2', date: '2025-02-05', description: 'edited' }).expect(200)).body;
      expect(bigger).toMatchObject({ fromAmount: '250', toAmount: '250', fees: '2', date: '2025-02-05', description: 'edited', outTransactionId: transfer.outTransactionId });
      expect(await cash(tokenA, from.id)).toEqual({ AUD: '748' });
      expect(await cash(tokenA, to.id)).toEqual({ AUD: '250' });
      const into = (await as(tokenA).get(`/api/transactions/${transfer.inTransactionId}`).expect(200)).body;
      expect(into).toMatchObject({ date: '2025-02-05', description: 'edited', amount: '250' });

      // Into another currency: needs a rate or toAmount
      await as(tokenA).patch(`/api/transfers/${transfer.id}`, { toCurrency: 'USD' }).expect(400);
      const fx = (await as(tokenA).patch(`/api/transfers/${transfer.id}`, { toCurrency: 'USD', rate: '0.6' }).expect(200)).body;
      expect(fx).toMatchObject({ fromAmount: '250', toAmount: '150', rate: '0.6', isFx: true, calculatedField: 'toAmount' });
      expect(await cash(tokenA, to.id)).toEqual({ USD: '150' });

      const moreAud = (await as(tokenA).patch(`/api/transfers/${transfer.id}`, { fromAmount: '300' }).expect(200)).body;
      expect(moreAud).toMatchObject({ toAmount: '180', rate: '0.6' });

      const backToAud = (await as(tokenA).patch(`/api/transfers/${transfer.id}`, { toCurrency: 'AUD' }).expect(200)).body;
      expect(backToAud).toMatchObject({ fromAmount: '300', toAmount: '300', rate: '1', isFx: false });

      const byTo = (await as(tokenA).patch(`/api/transfers/${transfer.id}`, { toAmount: '120' }).expect(200)).body;
      expect(byTo).toMatchObject({ fromAmount: '120', toAmount: '120' });

      const moved = await as(tokenA).patch(`/api/transfers/${transfer.id}`, { toAccountId: from.id }).expect(400);
      expect(moved.body.error.message).toMatch(/cannot be changed/);
      await as(tokenA).patch(`/api/transfers/${transfer.id}`, {}).expect(400);
    });

    it('refuses edits and deletes that would break either ledger', async () => {
      const from = await account(tokenA);
      const to = await account(tokenA);
      await deposit(tokenA, from.id, 'AUD', '100');
      const transfer = (await as(tokenA).post('/api/transfers', { fromAccountId: from.id, toAccountId: to.id, date: '2025-02-01', fromCurrency: 'AUD', fromAmount: '100' }).expect(201)).body;
      await as(tokenA).post(`/api/accounts/${to.id}/transactions`, { type: 'WITHDRAWAL', date: '2025-02-10', currency: 'AUD', amount: '80' }).expect(201);

      const tooMuch = await as(tokenA).patch(`/api/transfers/${transfer.id}`, { fromAmount: '101' }).expect(422);
      expect(tooMuch.body.error.details).toMatchObject({ side: 'source', transferId: transfer.id });
      const tooLittle = await as(tokenA).patch(`/api/transfers/${transfer.id}`, { fromAmount: '50' }).expect(422);
      expect(tooLittle.body.error.details).toMatchObject({ side: 'destination', accountId: to.id });
      await as(tokenA).patch(`/api/transfers/${transfer.id}`, { date: '2025-02-11' }).expect(422);
      const deleting = await as(tokenA).delete(`/api/transfers/${transfer.id}`).expect(422);
      expect(deleting.body.error.details.side).toBe('destination');

      expect(await cash(tokenA, from.id)).toEqual({ AUD: '0' });
      expect(await cash(tokenA, to.id)).toEqual({ AUD: '20' });
    });

    it('deletes both legs together', async () => {
      const from = await account(tokenA);
      const to = await account(tokenA);
      await deposit(tokenA, from.id, 'AUD', '100');
      const transfer = (await as(tokenA).post('/api/transfers', { fromAccountId: from.id, toAccountId: to.id, date: '2025-02-01', fromCurrency: 'AUD', fromAmount: '60' }).expect(201)).body;

      await as(tokenA).delete(`/api/transfers/${transfer.id}`).expect(200, { deleted: true, transactionsDeleted: 2 });
      await as(tokenA).get(`/api/transfers/${transfer.id}`).expect(404);
      await as(tokenA).get(`/api/transactions/${transfer.outTransactionId}`).expect(404);
      await as(tokenA).get(`/api/transactions/${transfer.inTransactionId}`).expect(404);
      expect(await cash(tokenA, from.id)).toEqual({ AUD: '100' });
      expect(await transactions(tokenA, to.id)).toEqual([]);
    });

    it('refuses to delete an account that takes part in transfers', async () => {
      const from = await account(tokenA);
      const to = await account(tokenA);
      await deposit(tokenA, from.id, 'AUD', '100');
      const transfer = (await as(tokenA).post('/api/transfers', { fromAccountId: from.id, toAccountId: to.id, date: '2025-02-01', fromCurrency: 'AUD', fromAmount: '60' }).expect(201)).body;

      for (const id of [from.id, to.id]) {
        const refused = await as(tokenA).delete(`/api/accounts/${id}?deleteTransactions=true`).expect(409);
        expect(refused.body.error.details).toEqual({ transferCount: 1 });
      }
      await as(tokenA).delete(`/api/transfers/${transfer.id}`).expect(200);
      await as(tokenA).delete(`/api/accounts/${to.id}`).expect(200);
      await as(tokenA).delete(`/api/accounts/${from.id}?deleteTransactions=true`).expect(200);
    });
  });

  describe('user isolation', () => {
    it("never lets one user transfer to, from, see or change another user's accounts or transfers", async () => {
      const mine = await account(tokenA);
      const mineToo = await account(tokenA);
      const theirs = await account(tokenB);
      await deposit(tokenA, mine.id, 'AUD', '100');
      await deposit(tokenB, theirs.id, 'AUD', '100');

      const toOther = await as(tokenA).post('/api/transfers', { fromAccountId: mine.id, toAccountId: theirs.id, date: '2025-02-01', fromCurrency: 'AUD', fromAmount: '10' }).expect(404);
      expect(toOther.body.error.message).toMatch(/Destination account/);
      const fromOther = await as(tokenA).post('/api/transfers', { fromAccountId: theirs.id, toAccountId: mine.id, date: '2025-02-01', fromCurrency: 'AUD', fromAmount: '10' }).expect(404);
      expect(fromOther.body.error.message).toMatch(/Source account/);
      expect(await cash(tokenB, theirs.id)).toEqual({ AUD: '100' });
      expect(await cash(tokenA, mine.id)).toEqual({ AUD: '100' });

      const transfer = (await as(tokenA).post('/api/transfers', { fromAccountId: mine.id, toAccountId: mineToo.id, date: '2025-02-01', fromCurrency: 'AUD', fromAmount: '10' }).expect(201)).body;
      await as(tokenB).get(`/api/transfers/${transfer.id}`).expect(404);
      await as(tokenB).patch(`/api/transfers/${transfer.id}`, { fromAmount: '1' }).expect(404);
      await as(tokenB).delete(`/api/transfers/${transfer.id}`).expect(404);
      await as(tokenB).get(`/api/transfers?accountId=${mine.id}`).expect(404);
      expect((await as(tokenB).get('/api/transfers').expect(200)).body).toEqual([]);
      await as(tokenB).get(`/api/transactions/${transfer.outTransactionId}`).expect(404);
      expect(await cash(tokenA, mineToo.id)).toEqual({ AUD: '10' });
    });
  });

  describe('MCP', () => {
    it('records, lists, edits and deletes transfers through the same services', async () => {
      const from = await account(tokenA);
      const to = await account(tokenA);
      await deposit(tokenA, from.id, 'AUD', '1000');

      const recorded = await callTool(t, mcpA, 'record_transfer', {
        fromAccountId: from.id, toAccountId: to.id, date: '2025-02-01', fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: '100', rate: 0.65,
      });
      expect(recorded.isError).toBe(false);
      expect(recorded.data).toMatchObject({ fromAmount: '100', toAmount: '65', rate: '0.65', isFx: true });

      const listed = await callTool(t, mcpA, 'list_transfers', { accountId: to.id });
      expect(listed.data.map((row: { id: string }) => row.id)).toEqual([recorded.data.id]);
      expect((await callTool(t, mcpA, 'get_transfer', { transferId: recorded.data.id })).data.id).toBe(recorded.data.id);

      const updated = await callTool(t, mcpA, 'update_transfer', { transferId: recorded.data.id, toAmount: '66', rate: null });
      expect(updated.data).toMatchObject({ toAmount: '66', rate: '0.66', calculatedField: 'rate' });

      const leg = await callTool(t, mcpA, 'delete_transaction', { transactionId: recorded.data.outTransactionId });
      expect(leg.isError).toBe(true);
      expect(leg.data.error.code).toBe('conflict');

      const tooMuch = await callTool(t, mcpA, 'record_transfer', { fromAccountId: from.id, toAccountId: to.id, date: '2025-02-01', fromCurrency: 'AUD', fromAmount: '5000' });
      expect(tooMuch.isError).toBe(true);
      expect(tooMuch.data.error.code).toBe('ledger_violation');

      expect((await callTool(t, mcpA, 'delete_transfer', { transferId: recorded.data.id })).data).toEqual({ deleted: true, transactionsDeleted: 2 });
      expect(await cash(tokenA, from.id)).toEqual({ AUD: '1000' });
    });
  });

  describe('concurrency', () => {
    it('serializes transfers out of one account, so they cannot both spend the same cash', async () => {
      const from = await account(tokenA);
      const a = await account(tokenA);
      const b = await account(tokenA);
      await deposit(tokenA, from.id, 'AUD', '100');
      const attempts = await Promise.all(
        [a, b, a, b].map((to) =>
          as(tokenA).post('/api/transfers', { fromAccountId: from.id, toAccountId: to.id, date: '2025-02-01', fromCurrency: 'AUD', fromAmount: '60' }),
        ),
      );
      expect(attempts.map((r) => r.status).sort()).toEqual([201, 422, 422, 422]);
      expect(await cash(tokenA, from.id)).toEqual({ AUD: '40' });
    });

    (usingRealPostgres ? it : it.skip)('does not deadlock when two accounts transfer to each other at the same time (Postgres only)', async () => {
      const x = await account(tokenA);
      const y = await account(tokenA);
      await deposit(tokenA, x.id, 'AUD', '1000');
      await deposit(tokenA, y.id, 'AUD', '1000');
      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          as(tokenA).post('/api/transfers', {
            fromAccountId: i % 2 ? x.id : y.id, toAccountId: i % 2 ? y.id : x.id, date: '2025-02-01', fromCurrency: 'AUD', fromAmount: '10',
          }),
        ),
      );
      expect(attempts.map((r) => r.status)).toEqual(Array(8).fill(201));
      expect(await cash(tokenA, x.id)).toEqual({ AUD: '1000' });
      expect(await cash(tokenA, y.id)).toEqual({ AUD: '1000' });
    });
  });
});
