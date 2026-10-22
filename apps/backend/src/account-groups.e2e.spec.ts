import { DataSource } from 'typeorm';
import { dec, fmt } from './common/decimal';
import { createUpMock, type UpMock } from 'up-bank-mock';
import { callTool, createTestApp, undoMigrationsThrough, type TestApp } from './test-support/test-app';

/** Logical account groups over Money accounts and (mock) imported Up accounts. Mock data only. */
describe('Account groups', () => {
  let t: TestApp;
  let up: UpMock;
  let tokenA: string;
  let tokenB: string;
  let mcpA: string;
  let upToken: string;
  let upAccounts: { id: string; displayName: string; balance: string }[];
  let cashInHand: { id: string };
  let brokerage: { id: string };

  beforeAll(async () => {
    up = createUpMock({ deliveryHosts: ['money.test'], retryDelaysMs: [5], fetch: async () => new Response('{}') });
    const baseUrl = await up.listen();
    t = await createTestApp({
      env: { UP_API_BASE_URL: baseUrl, UP_REGISTER_WEBHOOK: 'false', UP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') },
    });
    tokenA = await t.token({ subject: 'grp-a' });
    tokenB = await t.token({ subject: 'grp-b' });
    mcpA = await t.token({ subject: 'grp-a', audience: 'http://money.test/mcp' });

    upToken = 'up:user:group-token-abcdefgh';
    up.addCustomer(upToken);
    await as(tokenA).post('/api/up/connection', { token: upToken }).expect(201);
    upAccounts = (await as(tokenA).get('/api/up/accounts?visibility=all').expect(200)).body;
    const spending = upAccounts.find((a) => a.displayName === 'Spending')!;
    const savings = upAccounts.find((a) => a.displayName === 'Savings')!;
    await as(tokenA).put('/api/up/accounts/visibility', { visibleAccountIds: [spending.id, savings.id] }).expect(200);

    cashInHand = (await as(tokenA).post('/api/accounts', { name: 'Cash in hand', type: 'CASH', reportingCurrency: 'AUD' }).expect(201)).body;
    await as(tokenA).post(`/api/accounts/${cashInHand.id}/transactions`, { type: 'DEPOSIT', date: '2025-01-01', currency: 'AUD', amount: '200' }).expect(201);
    await as(tokenA).post(`/api/accounts/${cashInHand.id}/transactions`, { type: 'DEPOSIT', date: '2025-01-02', currency: 'USD', amount: '50' }).expect(201);
    brokerage = (await as(tokenA).post('/api/accounts', { name: 'Brokerage', type: 'INVESTMENT', reportingCurrency: 'AUD' }).expect(201)).body;
    await as(tokenA).post(`/api/accounts/${brokerage.id}/transactions`, { type: 'DEPOSIT', date: '2025-01-01', currency: 'AUD', amount: '1000' }).expect(201);
  });
  afterAll(async () => {
    await up.close();
    await t.close();
  });

  const as = (token: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: unknown) => t.http.post(url).set('Authorization', `Bearer ${token}`).send((body ?? {}) as object),
    patch: (url: string, body: unknown) => t.http.patch(url).set('Authorization', `Bearer ${token}`).send(body as object),
    put: (url: string, body: unknown) => t.http.put(url).set('Authorization', `Bearer ${token}`).send(body as object),
    delete: (url: string) => t.http.delete(url).set('Authorization', `Bearer ${token}`),
  });
  const bal = (name: string) => dec(up_(name).balance);
  const sum = (...values: ReturnType<typeof dec>[]) => fmt(values.reduce((a, b) => a.plus(b), dec(0)));
  const up_ = (name: string) => upAccounts.find((a) => a.displayName === name)!;
  const aud = (totals: any) => totals.byCurrency.find((c: any) => c.currency === 'AUD')?.total;
  const view = async (query = '') => (await as(tokenA).get(`/api/account-groups${query}`).expect(200)).body;

  let cashGroupId: string;

  it('creates a Cash group spanning Up and manual accounts, totalled per currency without double counting', async () => {
    const created = await as(tokenA)
      .post('/api/account-groups', {
        name: 'Cash',
        members: [
          { kind: 'up', id: up_('Spending').id },
          { kind: 'up', id: up_('Savings').id },
          { kind: 'account', id: cashInHand.id },
        ],
      })
      .expect(201);
    cashGroupId = created.body.id;
    expect(created.body.members.map((m: any) => [m.name, m.source]).sort()).toEqual([['Cash in hand', 'manual'], ['Savings', 'up'], ['Spending', 'up']]);
    expect(aud(created.body.totals)).toBe(sum(bal('Spending'), bal('Savings'), dec(200)));
    expect(created.body.totals.byCurrency.find((c: any) => c.currency === 'USD').total).toBe('50');

    const v = await view();
    expect(v.groups).toHaveLength(1);
    expect(v.ungrouped.map((m: any) => m.name)).toEqual(expect.arrayContaining(['Brokerage', '2Up Spending']));
    // Grouped + ungrouped = physical: Brokerage 1000 + group 1700 (the hidden 2Up account holds 0 and is not counted)
    expect(aud(v.totals)).toBe(sum(bal('Spending'), bal('Savings'), dec(1200))); // 2Up is hidden and not counted
    const report = (await as(tokenA).get('/api/reports/accounts').expect(200)).body;
    expect(aud(report.totals)).toBe(sum(bal('Spending'), bal('Savings'), dec(1200))); // manual plus visible imported accounts, once each; hidden 2Up is left out
  });

  it('converts group totals with the caller\'s explicit rates and splits composition by kind of account', async () => {
    const converted = (await as(tokenA).get(`/api/account-groups/${cashGroupId}?baseCurrency=AUD&fxRates=USD:1.5`).expect(200)).body;
    expect(converted.totals.converted).toMatchObject({ baseCurrency: 'AUD', total: sum(bal('Spending'), bal('Savings'), dec(275)) });
    expect(converted.composition).toEqual({ cash: sum(bal('Spending'), bal('Savings'), dec(275)), investments: '0', superannuation: '0', other: '0' });
    await as(tokenA).get('/api/account-groups?baseCurrency=AUD').expect(400); // USD has no rate: refused, not left out
  });

  it('allows an account in one group only, unless it is moved', async () => {
    const refused = await as(tokenA).post('/api/account-groups', { name: 'Everyday', members: [{ kind: 'up', id: up_('Spending').id }] }).expect(409);
    expect(refused.body.error.details.accounts[0]).toMatchObject({ kind: 'up', id: up_('Spending').id, groupId: cashGroupId });
    const moved = await as(tokenA).post('/api/account-groups', { name: 'Everyday', move: true, members: [{ kind: 'up', id: up_('Spending').id }] }).expect(201);
    expect(aud(moved.body.totals)).toBe(fmt(bal('Spending')));
    expect(aud((await view()).groups.find((g: any) => g.id === cashGroupId).totals)).toBe(sum(bal('Savings'), dec(200)));
    // Move it back and drop the extra group
    await as(tokenA).patch(`/api/account-groups/${cashGroupId}`, { move: true, members: [{ kind: 'up', id: up_('Spending').id }, { kind: 'up', id: up_('Savings').id }, { kind: 'account', id: cashInHand.id }] }).expect(200);
    const deleted = await as(tokenA).delete(`/api/account-groups/${moved.body.id}`).expect(200);
    expect(deleted.body).toEqual({ deleted: true, membersReleased: 0 });
    expect(aud((await view()).totals)).toBe(sum(bal('Spending'), bal('Savings'), dec(1200)));
  });

  it('names are unique per user, ignoring case', async () => {
    await as(tokenA).post('/api/account-groups', { name: 'cash' }).expect(409);
    await as(tokenB).post('/api/account-groups', { name: 'cash' }).expect(201); // another user may reuse it
  });

  it('keeps hidden Up accounts out of the totals but lists them, and counts them once shown', async () => {
    const twoUp = up_('2Up Spending');
    const withHidden = (await as(tokenA).patch(`/api/account-groups/${cashGroupId}`, { members: [...(await view()).groups[0].members.map((m: any) => ({ kind: m.kind, id: m.id })), { kind: 'up', id: twoUp.id }] }).expect(200)).body;
    const member = withHidden.members.find((m: any) => m.name === '2Up Spending');
    expect(member).toMatchObject({ counted: false, excludedReason: 'hidden', source: 'up' });
    expect(aud(withHidden.totals)).toBe(sum(bal('Spending'), bal('Savings'), dec(200)));
    await as(tokenA).put('/api/up/accounts/visibility', { visibleAccountIds: [up_('Spending').id, up_('Savings').id, twoUp.id] }).expect(200);
    expect((await as(tokenA).get(`/api/account-groups/${cashGroupId}`).expect(200)).body.members.find((m: any) => m.name === '2Up Spending').counted).toBe(true);
    await as(tokenA).put('/api/up/accounts/visibility', { visibleAccountIds: [up_('Spending').id, up_('Savings').id] }).expect(200);
  });

  it('does not count an Up account twice when its linked Money account is in the same group', async () => {
    await as(tokenA).patch(`/api/up/accounts/${up_('Savings').id}`, { linkedAccountId: cashInHand.id }).expect(200);
    const g = (await as(tokenA).get(`/api/account-groups/${cashGroupId}`).expect(200)).body;
    expect(g.members.find((m: any) => m.name === 'Savings')).toMatchObject({ counted: false, excludedReason: 'linked-duplicate' });
    expect(aud(g.totals)).toBe(sum(bal('Spending'), dec(200)));
    await as(tokenA).patch(`/api/up/accounts/${up_('Savings').id}`, { linkedAccountId: null }).expect(200);
    expect(aud((await as(tokenA).get(`/api/account-groups/${cashGroupId}`).expect(200)).body.totals)).toBe(sum(bal('Spending'), bal('Savings'), dec(200)));
  });

  it('counts a Money account with its own ledger only, so a parent and its subaccount can be grouped without overlap', async () => {
    const sub = (await as(tokenA).post('/api/accounts', { name: 'Sub bucket', type: 'CASH', reportingCurrency: 'AUD', parentAccountId: brokerage.id }).expect(201)).body;
    await as(tokenA).post(`/api/accounts/${sub.id}/transactions`, { type: 'DEPOSIT', date: '2025-01-03', currency: 'AUD', amount: '300' }).expect(201);
    const g = (await as(tokenA).post('/api/account-groups', { name: 'Brokerage side', members: [{ kind: 'account', id: brokerage.id }, { kind: 'account', id: sub.id }] }).expect(201)).body;
    expect(aud(g.totals)).toBe('1300'); // 1000 own + 300, not 1000 + 1300
    expect(aud((await view()).totals)).toBe(sum(bal('Spending'), bal('Savings'), dec(1500))); // sub's 300 is added once; grouping moves nothing
  });

  it('releases members when a group is deleted and when an account or Up data is removed', async () => {
    const temp = (await as(tokenA).post('/api/accounts', { name: 'Temporary', type: 'CASH', reportingCurrency: 'AUD' }).expect(201)).body;
    const g = (await as(tokenA).post('/api/account-groups', { name: 'Temp group', members: [{ kind: 'account', id: temp.id }] }).expect(201)).body;
    await as(tokenA).delete(`/api/accounts/${temp.id}`).expect(200);
    expect((await as(tokenA).get(`/api/account-groups/${g.id}`).expect(200)).body.members).toEqual([]); // empty group is valid
    const out = (await as(tokenA).delete(`/api/account-groups/${g.id}`).expect(200)).body;
    expect(out.deleted).toBe(true);
    await as(tokenA).get(`/api/account-groups/${g.id}`).expect(404);

    // Disconnecting Up without purge keeps the imported data and the memberships; purge releases them
    const before = (await as(tokenA).get(`/api/account-groups/${cashGroupId}`).expect(200)).body.members.length;
    await as(tokenA).delete('/api/up/connection').expect(200);
    expect((await as(tokenA).get(`/api/account-groups/${cashGroupId}`).expect(200)).body.members).toHaveLength(before);
    await as(tokenA).delete('/api/up/connection?purge=true').expect(200);
    const after = (await as(tokenA).get(`/api/account-groups/${cashGroupId}`).expect(200)).body;
    expect(after.members.map((m: any) => m.name)).toEqual(['Cash in hand']);
    expect(aud(after.totals)).toBe('200');
  });

  it('isolates users: groups, accounts and Up accounts of another user answer 404', async () => {
    expect((await as(tokenB).get('/api/account-groups').expect(200)).body.groups.map((g: any) => g.name)).toEqual(['cash']);
    await as(tokenB).get(`/api/account-groups/${cashGroupId}`).expect(404);
    await as(tokenB).patch(`/api/account-groups/${cashGroupId}`, { name: 'Mine now' }).expect(404);
    await as(tokenB).delete(`/api/account-groups/${cashGroupId}`).expect(404);
    const mine = (await as(tokenB).get('/api/account-groups').expect(200)).body.groups[0];
    await as(tokenB).patch(`/api/account-groups/${mine.id}`, { members: [{ kind: 'account', id: cashInHand.id }] }).expect(404);
    await as(tokenB).patch(`/api/account-groups/${mine.id}`, { members: [{ kind: 'up', id: up_('Savings').id }] }).expect(404);
  });

  it('refuses cross-user references at the database even if the service were bypassed', async () => {
    const ds = t.app.get(DataSource);
    const [{ id: userB }] = await ds.query(`SELECT user_id AS id FROM account_groups WHERE name = 'cash'`);
    const [{ id: groupB }] = await ds.query(`SELECT id FROM account_groups WHERE user_id = $1`, [userB]);
    const insert = (sql: string, params: unknown[]) => ds.transaction((m) => m.query(sql, params));
    await expect(insert(`INSERT INTO account_group_members (id, group_id, user_id) VALUES (gen_random_uuid(), $1, $2)`, [groupB, userB])).rejects.toThrow(); // needs exactly one kind
    await expect(
      insert(`INSERT INTO account_group_members (id, group_id, user_id, account_id) VALUES (gen_random_uuid(), $1, $2, $3)`, [groupB, userB, cashInHand.id]),
    ).rejects.toThrow();
  });

  it('works through MCP with the same rules', async () => {
    const list = await callTool(t, mcpA, 'list_account_groups', {});
    expect(JSON.stringify(list)).toContain('Cash in hand');
    const created = await callTool(t, mcpA, 'create_account_group', { name: 'Via MCP', members: [{ kind: 'account', id: cashInHand.id }] });
    expect(JSON.stringify(created)).toMatch(/conflict|already in another group/i);
  });

  it('migrates the group tables down and back up', async () => {
    const ds = t.app.get(DataSource);
    await undoMigrationsThrough(ds, 'AccountGroups1762200000000');
    const [{ exists }] = await ds.query(`SELECT to_regclass('account_groups') IS NOT NULL AS exists`);
    expect(exists).toBe(false);
    await ds.runMigrations();
    const [{ count }] = await ds.query(`SELECT count(*)::int AS count FROM account_groups`);
    expect(count).toBe(0);
  });
});
