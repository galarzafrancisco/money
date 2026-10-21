import { DataSource } from 'typeorm';
import { callTool, createTestApp, usingRealPostgres, type TestApp } from './test-support/test-app';
import { ValuationJobService } from './valuations/valuation-job.service';

/**
 * Specific identification of sold lots over REST and MCP, against the real
 * app and database: the 100/200 → 15/25 example, edits, deletes, backdating,
 * FIFO compatibility, valuation history and cross-user isolation.
 */
describe('specific lot selection for sales', () => {
  let t: TestApp;
  let tokenA: string;
  let tokenB: string;
  let mcpA: string;
  let mcpB: string;

  const as = (token: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: unknown) => t.http.post(url).set('Authorization', `Bearer ${token}`).send(body as object),
    patch: (url: string, body: unknown) => t.http.patch(url).set('Authorization', `Bearer ${token}`).send(body as object),
    delete: (url: string) => t.http.delete(url).set('Authorization', `Bearer ${token}`),
  });
  const newAccount = async (token: string, name: string) => {
    const account = (await as(token).post('/api/accounts', { name }).expect(201)).body as { id: string };
    await as(token).post(`/api/accounts/${account.id}/transactions`, { type: 'DEPOSIT', date: '2024-01-01', currency: 'USD', amount: '100000' }).expect(201);
    return account.id;
  };
  const record = (token: string, accountId: string, body: Record<string, unknown>) => as(token).post(`/api/accounts/${accountId}/transactions`, body);
  const buy = async (token: string, accountId: string, date: string, quantity: string, unitPrice: string, symbol = 'VOO') =>
    (await record(token, accountId, { type: 'BUY', date, symbol, currency: 'USD', quantity, unitPrice, fees: '0' }).expect(201)).body.id as string;
  const sellBody = (date: string, quantity: string, allocations?: { lotId: string; quantity: string }[]) => ({
    type: 'SELL', date, symbol: 'VOO', currency: 'USD', quantity, unitPrice: '30', fees: '10', ...(allocations ? { allocations } : {}),
  });
  const lots = async (token: string, accountId: string, query = '') =>
    (await as(token).get(`/api/accounts/${accountId}/lots${query}`).expect(200)).body.lots as { lotId: string; remainingQuantity: string; status: string }[];
  const remaining = async (token: string, accountId: string, query = '') =>
    Object.fromEntries((await lots(token, accountId, query)).map((l) => [l.lotId, l.remainingQuantity]));

  beforeAll(async () => {
    t = await createTestApp();
    tokenA = await t.token({ subject: 'lots-a' });
    tokenB = await t.token({ subject: 'lots-b' });
    mcpA = await t.token({ subject: 'lots-a', audience: 'http://money.test/mcp' });
    mcpB = await t.token({ subject: 'lots-b', audience: 'http://money.test/mcp' });
  });
  afterAll(() => t.close());

  describe('the 100/200 example over REST', () => {
    let accountId: string;
    let lotA: string;
    let lotB: string;
    let saleId: string;

    beforeAll(async () => {
      accountId = await newAccount(tokenA, 'Example');
      lotA = await buy(tokenA, accountId, '2024-01-10', '100', '10');
      lotB = await buy(tokenA, accountId, '2024-06-10', '200', '20');
    });

    it('lists the purchase lots with stable IDs, dates, ticker, account, quantity and cost base', async () => {
      const body = (await as(tokenA).get(`/api/accounts/${accountId}/lots?symbol=voo&asOf=2025-03-01`).expect(200)).body;
      expect(body.lots).toEqual([
        expect.objectContaining({ lotId: lotA, buyTransactionId: lotA, accountId, symbol: 'VOO', currency: 'USD', acquiredOn: '2024-01-10', status: 'OPEN', originalQuantity: '100', remainingQuantity: '100', remainingCostBase: '1000', unitCostBase: '10', heldOverTwelveMonths: true }),
        expect.objectContaining({ lotId: lotB, acquiredOn: '2024-06-10', remainingQuantity: '200', remainingCostBase: '4000', heldOverTwelveMonths: false }),
      ]);
      expect(body.notes.join(' ')).toMatch(/not tax advice/);
    });

    it('records a sale of 40 split 15 from A and 25 from B, leaving 85 and 175', async () => {
      const sale = await record(tokenA, accountId, sellBody('2025-03-01', '40', [{ lotId: lotA, quantity: '15' }, { lotId: lotB, quantity: '25' }])).expect(201);
      saleId = sale.body.id;
      expect(sale.body).toMatchObject({ lotSelection: 'SPECIFIC', allocations: [{ lotId: lotA, quantity: '15' }, { lotId: lotB, quantity: '25' }] });
      expect(await remaining(tokenA, accountId)).toEqual({ [lotA]: '85', [lotB]: '175' });
      // Lots as of the day before still show everything
      expect(await remaining(tokenA, accountId, '?asOf=2025-02-28')).toEqual({ [lotA]: '100', [lotB]: '200' });
    });

    it('reports per-allocation cost base, fees, proceeds, gain and holding period that reconcile with the sale', async () => {
      const body = (await as(tokenA).get(`/api/transactions/${saleId}/allocations`).expect(200)).body;
      expect(body).toMatchObject({ saleTransactionId: saleId, lotSelection: 'SPECIFIC', quantity: '40', fees: '10', total: '1190' });
      expect(body.allocations).toEqual([
        { lotId: lotA, acquiredOn: '2024-01-10', quantity: '15', unitCostBase: '10', costBase: '150', grossProceeds: '450', fees: '3.75', proceeds: '446.25', gain: '296.25', daysHeld: 416, heldOverTwelveMonths: true },
        { lotId: lotB, acquiredOn: '2024-06-10', quantity: '25', unitCostBase: '20', costBase: '500', grossProceeds: '750', fees: '6.25', proceeds: '743.75', gain: '243.75', daysHeld: 264, heldOverTwelveMonths: false },
      ]);
      expect(body.totals).toEqual({ quantity: '40', costBase: '650', grossProceeds: '1200', fees: '10', proceeds: '1190', gain: '540' });

      const portfolio = (await as(tokenA).get(`/api/accounts/${accountId}/portfolio?prices=false`).expect(200)).body;
      expect(portfolio.realized.disposals.map((d: { lotId: string; selection: string }) => [d.lotId, d.selection])).toEqual([[lotA, 'SPECIFIC'], [lotB, 'SPECIFIC']]);
      expect(portfolio.holdings[0].lots.map((l: { remainingQuantity: string }) => l.remainingQuantity)).toEqual(['85', '175']);
    });

    it('supports repeated partial sales from the same lots', async () => {
      const second = await record(tokenA, accountId, sellBody('2025-03-02', '100', [{ lotId: lotA, quantity: '85' }, { lotId: lotB, quantity: '15' }])).expect(201);
      expect(await remaining(tokenA, accountId)).toEqual({ [lotB]: '160' });
      const closed = await lots(tokenA, accountId, '?includeClosed=true');
      expect(closed.find((l) => l.lotId === lotA)).toMatchObject({ status: 'CLOSED', remainingQuantity: '0' });
      // Over-allocating the now empty lot is refused, and nothing is written
      const refused = await record(tokenA, accountId, sellBody('2025-03-03', '1', [{ lotId: lotA, quantity: '1' }])).expect(422);
      expect(refused.body.error).toMatchObject({ code: 'ledger_violation' });
      expect(refused.body.error.message).toMatch(/only 0 shares left/);
      await as(tokenA).delete(`/api/transactions/${second.body.id}`).expect(200);
      expect(await remaining(tokenA, accountId)).toEqual({ [lotA]: '85', [lotB]: '175' });
    });

    it('shows a sale being edited as available again with excludeTransactionId', async () => {
      expect(await remaining(tokenA, accountId, `?excludeTransactionId=${saleId}`)).toEqual({ [lotA]: '100', [lotB]: '200' });
    });
  });

  describe('validation', () => {
    let accountId: string;
    let lotA: string;
    let lotB: string;
    let lotTsla: string;
    let lotLater: string;

    beforeAll(async () => {
      accountId = await newAccount(tokenA, 'Validation');
      lotA = await buy(tokenA, accountId, '2024-01-10', '100', '10');
      lotB = await buy(tokenA, accountId, '2024-06-10', '200', '20');
      lotTsla = await buy(tokenA, accountId, '2024-06-10', '5', '100', 'TSLA');
      lotLater = await buy(tokenA, accountId, '2025-06-01', '10', '20');
    });

    it.each([
      ['allocations that do not add up', () => [{ lotId: lotA, quantity: '15' }, { lotId: lotB, quantity: '20' }], '40', 400, /add up to 35/],
      ['a zero quantity', () => [{ lotId: lotA, quantity: '40' }, { lotId: lotB, quantity: '0' }], '40', 400, /greater than zero/],
      ['a negative quantity', () => [{ lotId: lotA, quantity: '50' }, { lotId: lotB, quantity: '-10' }], '40', 400, /greater than zero/],
      ['a lot named twice', () => [{ lotId: lotA, quantity: '20' }, { lotId: lotA, quantity: '20' }], '40', 400, /more than once/],
      ['a malformed lot ID', () => [{ lotId: 'lot-a', quantity: '40' }], '40', 400, /lotId/],
      ['an empty list', () => [], '40', 400, /at least one lot/],
      ['a lot that does not exist', () => [{ lotId: '00000000-0000-4000-8000-000000000000', quantity: '40' }], '40', 422, /not a purchase of VOO in this account/],
      ['a lot of another ticker', () => [{ lotId: lotTsla, quantity: '5' }], '5', 422, /purchase of TSLA/],
      ['a lot bought after the sale date', () => [{ lotId: lotLater, quantity: '10' }, { lotId: lotA, quantity: '30' }], '40', 422, /after this sale/],
      ['more than the lot holds', () => [{ lotId: lotA, quantity: '101' }], '101', 422, /only 100 shares left/],
    ])('rejects %s without writing anything', async (_label, allocations, quantity, status, pattern) => {
      const response = await record(tokenA, accountId, sellBody('2025-03-01', quantity, allocations() as { lotId: string; quantity: string }[])).expect(status);
      expect(JSON.stringify(response.body.error)).toMatch(pattern);
      const listed = (await as(tokenA).get(`/api/accounts/${accountId}/transactions?type=SELL`).expect(200)).body;
      expect(listed).toHaveLength(0);
    });

    it('refuses allocations on anything but a SELL', async () => {
      await record(tokenA, accountId, { type: 'BUY', date: '2025-01-01', symbol: 'VOO', currency: 'USD', quantity: '1', unitPrice: '1', fees: '0', allocations: [{ lotId: lotA, quantity: '1' }] }).expect(400);
    });
  });

  describe('edits, deletes and backdating', () => {
    let accountId: string;
    let lotA: string;
    let lotB: string;
    let saleId: string;

    beforeEach(async () => {
      accountId = await newAccount(tokenA, `Edits ${Math.random()}`);
      lotA = await buy(tokenA, accountId, '2024-01-10', '100', '10');
      lotB = await buy(tokenA, accountId, '2024-06-10', '200', '20');
      saleId = (await record(tokenA, accountId, sellBody('2025-03-01', '40', [{ lotId: lotA, quantity: '15' }, { lotId: lotB, quantity: '25' }])).expect(201)).body.id;
    });

    it('replaces allocations on edit', async () => {
      const edited = await as(tokenA).patch(`/api/transactions/${saleId}`, { allocations: [{ lotId: lotB, quantity: '40' }] }).expect(200);
      expect(edited.body).toMatchObject({ lotSelection: 'SPECIFIC', allocations: [{ lotId: lotB, quantity: '40' }] });
      expect(await remaining(tokenA, accountId)).toEqual({ [lotA]: '100', [lotB]: '160' });
    });

    it('keeps allocations on other edits, and refuses a quantity they no longer add up to', async () => {
      const edited = await as(tokenA).patch(`/api/transactions/${saleId}`, { description: 'tax parcel pick', unitPrice: '31', total: null }).expect(200);
      expect(edited.body).toMatchObject({ allocations: [{ lotId: lotA, quantity: '15' }, { lotId: lotB, quantity: '25' }], total: '1230' });
      const refused = await as(tokenA).patch(`/api/transactions/${saleId}`, { quantity: '50', total: null }).expect(400);
      expect(refused.body.error.message).toMatch(/add up to 40 shares but the sale is for 50/);
      await as(tokenA).patch(`/api/transactions/${saleId}`, { quantity: '50', total: null, allocations: [{ lotId: lotA, quantity: '50' }] }).expect(200);
      expect(await remaining(tokenA, accountId)).toEqual({ [lotA]: '50', [lotB]: '200' });
    });

    it('switches to FIFO with allocations: null, and back', async () => {
      const fifo = await as(tokenA).patch(`/api/transactions/${saleId}`, { allocations: null }).expect(200);
      expect(fifo.body).toMatchObject({ lotSelection: 'FIFO', allocations: null });
      expect(await remaining(tokenA, accountId)).toEqual({ [lotA]: '60', [lotB]: '200' });
      await as(tokenA).patch(`/api/transactions/${saleId}`, { allocations: [{ lotId: lotB, quantity: '40' }] }).expect(200);
      expect(await remaining(tokenA, accountId)).toEqual({ [lotA]: '100', [lotB]: '160' });
    });

    it('refuses to delete a purchase that a sale allocates from', async () => {
      const refused = await as(tokenA).delete(`/api/transactions/${lotA}`).expect(409);
      expect(refused.body.error.details).toEqual({ saleTransactionIds: [saleId] });
      await as(tokenA).get(`/api/transactions/${lotA}`).expect(200);
    });

    it('refuses edits to a purchase that break an allocation: smaller, later, or another ticker', async () => {
      await as(tokenA).patch(`/api/transactions/${lotA}`, { quantity: '10', total: null }).expect(422);
      await as(tokenA).patch(`/api/transactions/${lotA}`, { date: '2025-04-01' }).expect(422);
      await as(tokenA).patch(`/api/transactions/${lotA}`, { symbol: 'VTI' }).expect(422);
      // Shrinking it to exactly what was taken is fine
      await as(tokenA).patch(`/api/transactions/${lotA}`, { quantity: '15', total: null }).expect(200);
      expect(await remaining(tokenA, accountId)).toEqual({ [lotB]: '175' });
    });

    it('refuses a backdated sale that would take shares a later explicit sale relies on', async () => {
      // 100 left in A after a 95-share explicit sale later on
      await as(tokenA).patch(`/api/transactions/${saleId}`, { quantity: '95', total: null, allocations: [{ lotId: lotA, quantity: '95' }] }).expect(200);
      const refused = await record(tokenA, accountId, sellBody('2024-12-01', '10')).expect(422);
      expect(refused.body.error.message).toMatch(/only 90 shares left/);
      // Backdating an explicit sale to before the lot was bought is refused too
      await as(tokenA).patch(`/api/transactions/${saleId}`, { date: '2023-12-31' }).expect(422);
      // The same backdated sale pointed at lot B fits
      await record(tokenA, accountId, sellBody('2024-12-01', '10', [{ lotId: lotB, quantity: '10' }])).expect(201);
      expect(await remaining(tokenA, accountId)).toEqual({ [lotA]: '5', [lotB]: '190' });
    });

    it('deletes a specific sale with its allocations, so the purchase can then be deleted', async () => {
      await as(tokenA).delete(`/api/transactions/${saleId}`).expect(200);
      await as(tokenA).delete(`/api/transactions/${lotA}`).expect(200);
      const ds = t.app.get(DataSource);
      const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM sale_lot_allocations WHERE sale_transaction_id = $1`, [saleId]);
      expect(count).toBe(0);
    });

    it('keeps the database from orphaning allocations even if the service check were bypassed', async () => {
      const ds = t.app.get(DataSource);
      await expect(
        ds.transaction(async (manager) => {
          await manager.query(`DELETE FROM transactions WHERE id = $1`, [lotA]);
        }),
      ).rejects.toThrow(/FK_sale_lot_allocations_lot/);
      await as(tokenA).get(`/api/transactions/${lotA}`).expect(200);
    });

    it('deletes an account with allocated sales in one go', async () => {
      await as(tokenA).delete(`/api/accounts/${accountId}?deleteTransactions=true`).expect(200);
      const ds = t.app.get(DataSource);
      const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM sale_lot_allocations WHERE account_id = $1`, [accountId]);
      expect(count).toBe(0);
    });
  });

  describe('FIFO compatibility', () => {
    it('keeps sales without allocations on FIFO, as before', async () => {
      const accountId = await newAccount(tokenA, 'FIFO');
      const lotA = await buy(tokenA, accountId, '2024-01-10', '10', '100');
      const lotB = await buy(tokenA, accountId, '2024-06-01', '10', '200');
      const sale = await record(tokenA, accountId, { type: 'SELL', date: '2025-01-11', symbol: 'VOO', currency: 'USD', quantity: '15', unitPrice: '300', fees: '15' }).expect(201);
      expect(sale.body).toMatchObject({ lotSelection: 'FIFO', allocations: null });
      const body = (await as(tokenA).get(`/api/transactions/${sale.body.id}/allocations`).expect(200)).body;
      expect(body.lotSelection).toBe('FIFO');
      expect(body.allocations.map((a: { lotId: string; quantity: string; costBase: string }) => [a.lotId, a.quantity, a.costBase])).toEqual([
        [lotA, '10', '1000'],
        [lotB, '5', '1000'],
      ]);
      expect(body.totals.proceeds).toBe('4485');
    });

    it('marks every SELL with a lot selection in the database (the migration backfills FIFO)', async () => {
      const ds = t.app.get(DataSource);
      const [{ missing }] = await ds.query(`SELECT count(*)::int AS missing FROM transactions WHERE type = 'SELL' AND lot_selection IS NULL`);
      expect(missing).toBe(0);
      const [{ stray }] = await ds.query(`SELECT count(*)::int AS stray FROM transactions WHERE type <> 'SELL' AND lot_selection IS NOT NULL`);
      expect(stray).toBe(0);
    });

    it('answers 400 for allocations of a non-sale', async () => {
      const accountId = await newAccount(tokenA, 'Not a sale');
      const lot = await buy(tokenA, accountId, '2024-01-10', '1', '1');
      await as(tokenA).get(`/api/transactions/${lot}/allocations`).expect(400);
    });
  });

  describe('valuation history', () => {
    it('values historical lots by the actual allocations and recomputes after an allocation edit', async () => {
      const job = t.app.get(ValuationJobService);
      const accountId = await newAccount(tokenA, 'Valued');
      t.prices.setClose('VAL', '2025-03-03', '50');
      t.prices.setClose('VAL', '2025-03-04', '50');
      const buyVal = async (date: string, quantity: string, unitPrice: string) =>
        (await record(tokenA, accountId, { type: 'BUY', date, symbol: 'VAL', currency: 'USD', quantity, unitPrice, fees: '0' }).expect(201)).body.id as string;
      const lotA = await buyVal('2025-03-03', '100', '10');
      const lotB = await buyVal('2025-03-03', '200', '20');
      const sale = (await record(tokenA, accountId, { type: 'SELL', date: '2025-03-04', symbol: 'VAL', currency: 'USD', quantity: '40', unitPrice: '50', fees: '0', allocations: [{ lotId: lotA, quantity: '15' }, { lotId: lotB, quantity: '25' }] }).expect(201)).body;

      await job.runOnce(new Date('2025-03-05T08:00:00Z'));
      const holding = async () => {
        const body = (await as(tokenA).get(`/api/valuations?fromDate=2025-03-04&toDate=2025-03-04&include=holdings&accountId=${accountId}`).expect(200)).body;
        return body.days[0].holdings.find((h: { symbol: string }) => h.symbol === 'VAL');
      };
      let val = await holding();
      expect(val).toMatchObject({ quantity: '260', costBase: '4350' });
      expect(val.lots.map((l: { lotId: string; quantity: string }) => [l.lotId, l.quantity])).toEqual([[lotA, '85'], [lotB, '175']]);

      // Re-allocating the sale is a backdated change: the job re-values from the sale date
      await as(tokenA).patch(`/api/transactions/${sale.id}`, { allocations: [{ lotId: lotA, quantity: '40' }] }).expect(200);
      await job.runOnce(new Date('2025-03-05T09:00:00Z'));
      val = await holding();
      expect(val).toMatchObject({ quantity: '260', costBase: '4600' });
      expect(val.lots.map((l: { lotId: string; quantity: string }) => [l.lotId, l.quantity])).toEqual([[lotA, '60'], [lotB, '200']]);
    });
  });

  describe('MCP', () => {
    it('lists lots, records a split sale and reports its allocations through the same services', async () => {
      const account = (await callTool(t, mcpA, 'create_account', { name: 'MCP lots' })).data;
      await callTool(t, mcpA, 'record_deposit', { accountId: account.id, date: '2024-01-01', currency: 'USD', amount: '100000' });
      const a = (await callTool(t, mcpA, 'record_buy', { accountId: account.id, date: '2024-01-10', symbol: 'VOO', currency: 'USD', quantity: '100', unitPrice: '10', fees: '0' })).data;
      const b = (await callTool(t, mcpA, 'record_buy', { accountId: account.id, date: '2024-06-10', symbol: 'VOO', currency: 'USD', quantity: '200', unitPrice: '20', fees: '0' })).data;
      const listed = (await callTool(t, mcpA, 'list_lots', { accountId: account.id, asOf: '2025-03-01' })).data;
      expect(listed.lots.map((l: { lotId: string }) => l.lotId)).toEqual([a.id, b.id]);

      const sale = await callTool(t, mcpA, 'record_sell', {
        accountId: account.id, date: '2025-03-01', symbol: 'VOO', currency: 'USD', quantity: '40', unitPrice: '30', fees: '10',
        allocations: [{ lotId: a.id, quantity: '15' }, { lotId: b.id, quantity: '25' }],
      });
      expect(sale.isError).toBe(false);
      const allocations = (await callTool(t, mcpA, 'get_sale_allocations', { transactionId: sale.data.id })).data;
      expect(allocations.allocations.map((x: { quantity: string }) => x.quantity)).toEqual(['15', '25']);
      expect(allocations.totals).toMatchObject({ proceeds: '1190', fees: '10' });
      const after = (await callTool(t, mcpA, 'list_lots', { accountId: account.id })).data;
      expect(after.lots.map((l: { remainingQuantity: string }) => l.remainingQuantity)).toEqual(['85', '175']);

      const invalid = await callTool(t, mcpA, 'record_sell', {
        accountId: account.id, date: '2025-03-02', symbol: 'VOO', currency: 'USD', quantity: '10', unitPrice: '30', fees: '0',
        allocations: [{ lotId: a.id, quantity: '86' }],
      });
      expect(invalid.isError).toBe(true);

      const edited = await callTool(t, mcpA, 'update_transaction', { transactionId: sale.data.id, allocations: null });
      expect(edited.data).toMatchObject({ lotSelection: 'FIFO' });
    });
  });

  describe('isolation between users', () => {
    let accountA: string;
    let lotA: string;
    let saleA: string;
    let accountB: string;

    beforeAll(async () => {
      accountA = await newAccount(tokenA, 'Private');
      lotA = await buy(tokenA, accountA, '2024-01-10', '100', '10');
      saleA = (await record(tokenA, accountA, sellBody('2025-01-01', '10', [{ lotId: lotA, quantity: '10' }])).expect(201)).body.id;
      accountB = await newAccount(tokenB, 'Other');
      await buy(tokenB, accountB, '2024-01-10', '100', '10');
    });

    it("answers 404 for another user's lots and allocations on REST", async () => {
      await as(tokenB).get(`/api/accounts/${accountA}/lots`).expect(404);
      await as(tokenB).get(`/api/transactions/${saleA}/allocations`).expect(404);
      await as(tokenB).get(`/api/accounts/${accountB}/lots?excludeTransactionId=${saleA}`).expect(404);
    });

    it("cannot allocate from another user's lot, and the error does not reveal it", async () => {
      const refused = await record(tokenB, accountB, sellBody('2025-01-01', '10', [{ lotId: lotA, quantity: '10' }])).expect(422);
      expect(refused.body.error.message).toMatch(/is not a purchase of VOO in this account/);
      expect(JSON.stringify(refused.body)).not.toMatch(/2024-01-10/);
    });

    it("cannot allocate from the same user's lot in another account", async () => {
      const otherAccount = await newAccount(tokenA, 'Second broker');
      await buy(tokenA, otherAccount, '2024-01-10', '50', '10');
      await record(tokenA, otherAccount, sellBody('2025-01-01', '10', [{ lotId: lotA, quantity: '10' }])).expect(422);
    });

    it("answers not_found to the MCP tools on another user's data", async () => {
      for (const [tool, args] of [
        ['list_lots', { accountId: accountA }],
        ['get_sale_allocations', { transactionId: saleA }],
        ['update_transaction', { transactionId: saleA, allocations: null }],
      ] as const) {
        const result = await callTool(t, mcpB, tool, args);
        expect(result.isError).toBe(true);
        expect(result.data.error).toMatchObject({ code: 'not_found' });
      }
      const sale = (await as(tokenA).get(`/api/transactions/${saleA}`).expect(200)).body;
      expect(sale).toMatchObject({ lotSelection: 'SPECIFIC', allocations: [{ lotId: lotA, quantity: '10' }] });
    });
  });

  describe('concurrency', () => {
    it('serializes sales from one lot, so two cannot both take the same shares', async () => {
      const accountId = await newAccount(tokenA, 'Race');
      const lot = await buy(tokenA, accountId, '2024-01-10', '100', '10');
      const attempts = await Promise.all(
        Array.from({ length: 4 }, () => record(tokenA, accountId, sellBody('2025-01-01', '60', [{ lotId: lot, quantity: '60' }]))),
      );
      expect(attempts.map((r) => r.status).sort()).toEqual([201, 422, 422, 422]);
      expect(await remaining(tokenA, accountId)).toEqual({ [lot]: '40' });
    });

    (usingRealPostgres ? it : it.skip)('cannot delete a purchase while a sale allocating from it is being recorded (Postgres)', async () => {
      const accountId = await newAccount(tokenA, 'Race delete');
      const lot = await buy(tokenA, accountId, '2024-01-10', '100', '10');
      const [sale, deletion] = await Promise.all([
        record(tokenA, accountId, sellBody('2025-01-01', '10', [{ lotId: lot, quantity: '10' }])),
        as(tokenA).delete(`/api/transactions/${lot}`),
      ]);
      // Exactly one wins; never a sale pointing at a deleted purchase
      expect([sale.status, deletion.status].sort()).toEqual(sale.status === 201 ? [201, 409] : [200, 422]);
      const ds = t.app.get(DataSource);
      const [{ orphans }] = await ds.query(
        `SELECT count(*)::int AS orphans FROM sale_lot_allocations a LEFT JOIN transactions t ON t.id = a.lot_transaction_id WHERE t.id IS NULL`,
      );
      expect(orphans).toBe(0);
    });
  });
});
