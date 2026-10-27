import { DataSource } from 'typeorm';
import { callTool, createTestApp, undoMigrationsThrough, type TestApp } from './test-support/test-app';

/**
 * The tax ledger and asset register end to end, through REST and MCP:
 * the conference-ticket journey, a DGX-style depreciating asset, year
 * boundaries, double-counting guards, filing snapshots and amendments, and
 * user isolation. Synthetic figures only.
 */
describe('Tax ledger and depreciating assets', () => {
  let t: TestApp;
  let ds: DataSource;
  let tokenA: string;
  let tokenB: string;
  let mcpA: string;
  let bank: { id: string };
  let ticketTx: { id: string };
  let sparkTx: { id: string };

  const as = (token: string) => ({
    get: (url: string) => t.http.get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: unknown) => t.http.post(url).set('Authorization', `Bearer ${token}`).send((body ?? {}) as object),
    patch: (url: string, body: unknown) => t.http.patch(url).set('Authorization', `Bearer ${token}`).send(body as object),
    put: (url: string, body: unknown) => t.http.put(url).set('Authorization', `Bearer ${token}`).send(body as object),
    delete: (url: string) => t.http.delete(url).set('Authorization', `Bearer ${token}`),
  });

  beforeAll(async () => {
    t = await createTestApp();
    ds = t.app.get(DataSource);
    tokenA = await t.token({ subject: 'tax-a' });
    tokenB = await t.token({ subject: 'tax-b' });
    mcpA = await t.token({ subject: 'tax-a', audience: 'http://money.test/mcp' });
    bank = (await as(tokenA).post('/api/accounts', { name: 'Everyday', type: 'CASH', reportingCurrency: 'AUD' }).expect(201)).body;
    await as(tokenA).post(`/api/accounts/${bank.id}/transactions`, { type: 'DEPOSIT', date: '2025-07-01', currency: 'AUD', amount: '20000' }).expect(201);
    sparkTx = (await as(tokenA).post(`/api/accounts/${bank.id}/transactions`, { type: 'WITHDRAWAL', date: '2025-11-03', currency: 'AUD', amount: '6249', description: 'DGX Spark' }).expect(201)).body;
    ticketTx = (await as(tokenA).post(`/api/accounts/${bank.id}/transactions`, { type: 'WITHDRAWAL', date: '2026-09-12', currency: 'AUD', amount: '899', description: 'AI Engineering Conference' }).expect(201)).body;
  });
  afterAll(() => t.close());

  let ticketId: string;

  it('remembers a conference ticket before its transaction is linked, with intent and rationale', async () => {
    const res = await as(tokenA)
      .post('/api/tax/items', {
        description: 'AI Engineering Conference ticket',
        date: '2026-09-10',
        amount: '899',
        claimPercent: '100',
        category: 'Self education',
        rationale: 'Relates directly to my current work as an AI engineer',
      })
      .expect(201);
    ticketId = res.body.id;
    expect(res.body).toMatchObject({
      taxYear: '2026-27',
      kind: 'DEDUCTION',
      category: 'self-education',
      amount: '899.00',
      proposedAmount: '899.00',
      claimedAmount: null,
      status: 'TO_REVIEW',
      yearStatus: 'PREPARING',
      locked: false,
    });
    expect(res.body.gaps).toEqual(expect.arrayContaining(['needs-review', 'no-evidence', 'no-transaction']));
  });

  it('links the transaction later, changes the intent to 50 % and attaches a receipt URL', async () => {
    const link = await as(tokenA).post('/api/tax/links', { itemId: ticketId, transactionId: ticketTx.id }).expect(201);
    expect(link.body).toMatchObject({ itemId: ticketId, source: 'manual', accountName: 'Everyday', amount: '899.00', direction: 'out', date: '2026-09-12' });
    // Linking the same pair again is a no-op
    const again = await as(tokenA).post('/api/tax/links', { itemId: ticketId, transactionId: ticketTx.id }).expect(201);
    expect(again.body.id).toBe(link.body.id);

    await as(tokenA).patch(`/api/tax/items/${ticketId}`, { claimPercent: '50' }).expect(200);
    await as(tokenA).post('/api/tax/evidence', { itemId: ticketId, label: 'Receipt', url: 'https://drive.example.com/receipts/aie-2026.pdf', kind: 'RECEIPT' }).expect(201);
    const item = (await as(tokenA).get(`/api/tax/items/${ticketId}`).expect(200)).body;
    expect(item).toMatchObject({ claimPercent: '50', proposedAmount: '449.50', amountSource: 'entered' });
    expect(item.links).toHaveLength(1);
    expect(item.evidence).toEqual([expect.objectContaining({ label: 'Receipt', kind: 'RECEIPT' })]);
    expect(item.gaps).toEqual(['needs-review']);
  });

  it('refuses evidence that is not an http(s) URL, and has no upload endpoint', async () => {
    const bad = await as(tokenA).post('/api/tax/evidence', { itemId: ticketId, label: 'Local', url: 'file:///Users/me/receipt.pdf' }).expect(400);
    expect(bad.body.error.code).toBe('validation_failed');
  });

  it('takes the amount from linked transactions when none is entered', async () => {
    const item = (await as(tokenA).post('/api/tax/items', { description: 'Conference ticket (from bank)', taxYear: '2026-27', links: [{ transactionId: ticketTx.id }], allowShared: true }).expect(201)).body;
    expect(item).toMatchObject({ amount: null, amountSource: 'linked', effectiveAmount: '899.00', proposedAmount: '899.00' });
    expect(item.gaps).toContain('shared-transaction');
    // Without allowShared, a transaction already on another item is refused
    const refused = await as(tokenA).post('/api/tax/items', { description: 'Again', links: [{ transactionId: ticketTx.id }] }).expect(409);
    expect(refused.body.error.details.linkedTo).toHaveLength(2);
    await as(tokenA).delete(`/api/tax/items/${item.id}`).expect(200);
  });

  it('assigns the financial year from the date across the 30 June / 1 July boundary', async () => {
    const june = (await as(tokenA).post('/api/tax/items', { description: 'Subscription', date: '2026-06-30', amount: '10' }).expect(201)).body;
    const july = (await as(tokenA).post('/api/tax/items', { description: 'Subscription', date: '2026-07-01', amount: '10' }).expect(201)).body;
    expect([june.taxYear, july.taxYear]).toEqual(['2025-26', '2026-27']);
    // An explicit year that does not contain the date is kept, and flagged
    const prepaid = (await as(tokenA).post('/api/tax/items', { description: 'Prepaid', date: '2026-06-30', taxYear: 'FY2026-27', amount: '10' }).expect(201)).body;
    expect(prepaid.taxYear).toBe('2026-27');
    expect(prepaid.gaps).toContain('outside-year');
    const bad = await as(tokenA).post('/api/tax/items', { description: 'x', taxYear: '2026-28' }).expect(400);
    expect(bad.body.error.message).toContain('financial year');
    for (const id of [june.id, july.id, prepaid.id]) await as(tokenA).delete(`/api/tax/items/${id}`).expect(200);
  });

  let sparkId: string;

  it('registers a DGX-style asset with its payment, and estimates diminishing-value depreciation per year', async () => {
    const res = await as(tokenA)
      .post('/api/tax/assets', {
        name: 'NVIDIA DGX Spark',
        cost: '6249',
        acquiredOn: '2025-11-03',
        firstUsedOn: '2025-11-10',
        method: 'DIMINISHING_VALUE',
        effectiveLifeYears: '4',
        defaultUsePercent: '80',
        ownership: 'Owned by me; used for consulting and research at home',
        links: [{ transactionId: sparkTx.id }],
        evidence: [{ label: 'Invoice', url: 'https://drive.example.com/invoices/dgx.pdf', kind: 'INVOICE' }],
      })
      .expect(201);
    sparkId = res.body.id;
    expect(res.body).toMatchObject({ lifecycle: 'IN_USE', cost: '6249.00', method: 'DIMINISHING_VALUE' });
    expect(res.body.links[0]).toMatchObject({ transactionId: sparkTx.id, amount: '6249.00' });
    const first = res.body.schedule.rows[0];
    expect(first).toMatchObject({ taxYear: '2025-26', periodStart: '2025-11-10', daysHeld: 233, daysInYear: 365, openingValue: '6249.00', decline: '1994.54', usePercent: '80', deduction: '1595.63' });
    expect(res.body.schedule.ratePercent).toBe('50');
  });

  it('changes the work-use percentage for one year only', async () => {
    const res = await as(tokenA).put(`/api/tax/assets/${sparkId}/years/2026-27`, { usePercent: '60' }).expect(200);
    const rows = res.body.schedule.rows;
    expect(rows[1]).toMatchObject({ taxYear: '2026-27', openingValue: '4254.46', decline: '2127.23', usePercent: '60', usePercentSource: 'year', deduction: '1276.34' });
    expect(rows[2]).toMatchObject({ usePercent: '80', usePercentSource: 'default' });
    const schedule = (await as(tokenA).get(`/api/tax/assets/${sparkId}/schedule?throughYear=2027-28`).expect(200)).body;
    expect(schedule.rows.map((r: any) => r.taxYear)).toEqual(['2025-26', '2026-27', '2027-28']);
  });

  it('never counts the asset purchase twice', async () => {
    const asItem = await as(tokenA).post('/api/tax/items', { description: 'DGX Spark as an expense', links: [{ transactionId: sparkTx.id }] }).expect(409);
    expect(asItem.body.error.message).toContain('depreciating asset');
    // allowShared does not override it either
    await as(tokenA).post('/api/tax/links', { itemId: ticketId, transactionId: sparkTx.id, allowShared: true }).expect(409);
    // and an item's transaction cannot be linked to an asset
    await as(tokenA).post('/api/tax/links', { assetId: sparkId, transactionId: ticketTx.id }).expect(409);
  });

  it('summarises a year with items and depreciation, totals and gaps', async () => {
    await as(tokenA).post('/api/tax/items', { description: 'Tax agent fee', date: '2026-03-01', amount: '330', category: 'cost-of-managing-tax-affairs' }).expect(201);
    const s = (await as(tokenA).get('/api/tax/years/2025-26').expect(200)).body;
    expect(s).toMatchObject({ taxYear: '2025-26', status: 'PREPARING', period: { start: '2025-07-01', end: '2026-06-30', days: 365 } });
    expect(s.positions.map((p: any) => [p.source, p.description, p.proposedAmount])).toEqual([
      ['ITEM', 'Tax agent fee', '330.00'],
      ['ASSET', 'Decline in value: NVIDIA DGX Spark (estimate)', '1595.63'],
    ]);
    expect(s.totals.byKind).toEqual([{ kind: 'DEDUCTION', currency: 'AUD', count: 2, proposed: '1925.63', confirmed: '0.00', claimed: '0.00' }]);
    expect(s.gaps.counts['needs-review']).toBe(2);
    const years = (await as(tokenA).get('/api/tax/years').expect(200)).body;
    expect(years.years.map((y: any) => y.taxYear)).toEqual(expect.arrayContaining(['2026-27', '2025-26']));
  });

  it('files a year as an immutable snapshot and then refuses edits until it is reopened', async () => {
    const unreviewed = await as(tokenA).post('/api/tax/years/2025-26/filings', { filedOn: '2026-10-01' }).expect(409);
    expect(unreviewed.body.error.details.positions).toHaveLength(2);

    const items = (await as(tokenA).get('/api/tax/items?taxYear=2025-26').expect(200)).body.items;
    const fee = items.find((i: any) => i.description === 'Tax agent fee');
    await as(tokenA).patch(`/api/tax/items/${fee.id}`, { status: 'CONFIRMED', claimedAmount: '330' }).expect(200);
    await as(tokenA).put(`/api/tax/assets/${sparkId}/years/2025-26`, { status: 'CONFIRMED', claimedAmount: '1595.63' }).expect(200);

    const filed = (await as(tokenA).post('/api/tax/years/2025-26/filings', { filedOn: '2026-10-01', reference: 'MyTax-123' }).expect(201)).body;
    expect(filed.status).toBe('FILED');
    expect(filed.filings).toEqual([expect.objectContaining({ version: 1, kind: 'ORIGINAL', reference: 'MyTax-123', positionCount: 2 })]);
    expect(filed.totals.byKind[0]).toMatchObject({ confirmed: '1925.63', claimed: '1925.63' });

    const locked = await as(tokenA).patch(`/api/tax/items/${fee.id}`, { amount: '440' }).expect(409);
    expect(locked.body.error.message).toContain('is filed');
    await as(tokenA).post('/api/tax/items', { description: 'Late', taxYear: '2025-26', amount: '1' }).expect(409);
    await as(tokenA).put(`/api/tax/assets/${sparkId}/years/2025-26`, { usePercent: '90' }).expect(409);
    await as(tokenA).post('/api/tax/years/2025-26/filings', { filedOn: '2026-10-02' }).expect(409);
    // Moving an item into a filed year is refused too
    await as(tokenA).patch(`/api/tax/items/${ticketId}`, { taxYear: '2025-26' }).expect(409);
  });

  it('shows the filed figure beside a recomputed one instead of rewriting a filed year', async () => {
    const res = await as(tokenA).patch(`/api/tax/assets/${sparkId}`, { cost: '6000' }).expect(200);
    const row = res.body.schedule.rows[0];
    expect(row.filed).toEqual({ version: 1, deduction: '1595.63' });
    expect(row.driftFromFiled).toBe(true);
    const snapshot = (await as(tokenA).get('/api/tax/years/2025-26/filings/1').expect(200)).body;
    expect(snapshot.positions.find((p: any) => p.source === 'ASSET').proposedAmount).toBe('1595.63');
    await as(tokenA).patch(`/api/tax/assets/${sparkId}`, { cost: '6249' }).expect(200);
    // An asset in a filed return cannot be deleted
    const del = await as(tokenA).delete(`/api/tax/assets/${sparkId}`).expect(409);
    expect(del.body.error.details.filedTaxYears).toEqual(['2025-26']);
  });

  it('amends explicitly: reopen, change, file version 2, and keep version 1 unchanged', async () => {
    await as(tokenA).post('/api/tax/years/2025-26/amendment', {}).expect(400);
    const reopened = (await as(tokenA).post('/api/tax/years/2025-26/amendment', { reason: 'Missed a donation' }).expect(200)).body;
    expect(reopened).toMatchObject({ status: 'AMENDING', amendingReason: 'Missed a donation' });
    await as(tokenA).post('/api/tax/items', { description: 'Donation', taxYear: '2025-26', amount: '50', category: 'donations', status: 'CONFIRMED', claimedAmount: '50' }).expect(201);
    // While amending, the live figures lead and drift lists the changes since the last filing
    const amending = (await as(tokenA).get('/api/tax/years/2025-26').expect(200)).body;
    expect(amending).toMatchObject({ basis: 'LIVE', filedVersion: null, live: null });
    expect(amending.drift).toEqual([expect.objectContaining({ change: 'added', description: 'Donation', liveProposed: '50.00' })]);
    // A never-filed year has no drift
    expect((await as(tokenA).get('/api/tax/years/2026-27').expect(200)).body).toMatchObject({ basis: 'LIVE', drift: [] });
    const amended = (await as(tokenA).post('/api/tax/years/2025-26/filings', { filedOn: '2026-11-01' }).expect(201)).body;
    expect(amended.filings.map((f: any) => [f.version, f.kind, f.positionCount, f.amendmentReason])).toEqual([
      [1, 'ORIGINAL', 2, null],
      [2, 'AMENDMENT', 3, 'Missed a donation'],
    ]);
    const v1 = (await as(tokenA).get('/api/tax/years/2025-26/filings/1').expect(200)).body;
    expect(v1.positions).toHaveLength(2);
    const report = (await as(tokenA).get('/api/tax/years/2025-26/report?version=1').expect(200)).body;
    expect(report.markdown).toContain('Tax summary FY 2025-26');
    expect(report.markdown).not.toContain('Donation');
    const live = (await as(tokenA).get('/api/tax/years/2025-26/report').expect(200)).body;
    expect(live.markdown).toContain('Donation');
    expect(live.csv.split('\n')[0]).toBe('taxYear,kind,category,description,date,currency,amount,percent,proposedAmount,claimedAmount,status,source,links,evidence,gaps');
  });

  it('a filed year answers with its filing; later asset and source changes show as drift, not as new filed figures', async () => {
    const before = (await as(tokenA).get('/api/tax/years/2025-26').expect(200)).body;
    expect(before).toMatchObject({ status: 'FILED', basis: 'FILED', filedVersion: 2, drift: [] });
    const filedTotals = before.totals;

    const spark = (await as(tokenA).get(`/api/tax/assets/${sparkId}`).expect(200)).body;
    await as(tokenA).patch(`/api/tax/assets/${sparkId}`, { cost: '6000', name: 'DGX Spark (renamed)' }).expect(200);
    await as(tokenA).patch(`/api/transactions/${sparkTx.id}`, { description: 'Edited later' }).expect(200);
    await as(tokenA).delete(`/api/tax/evidence/${spark.evidence[0].id}`).expect(200);

    const s = (await as(tokenA).get('/api/tax/years/2025-26').expect(200)).body;
    expect(s.basis).toBe('FILED');
    expect(s.totals).toEqual(filedTotals);
    const filedAsset = s.positions.find((p: any) => p.source === 'ASSET');
    expect(filedAsset).toMatchObject({ description: 'Decline in value: NVIDIA DGX Spark (estimate)', proposedAmount: '1595.63', evidenceCount: 1 });
    expect(s.live.positions.find((p: any) => p.source === 'ASSET')).toMatchObject({ description: 'Decline in value: DGX Spark (renamed) (estimate)', evidenceCount: 0 });
    expect(s.live.totals.byKind[0].proposed).not.toBe(filedTotals.byKind[0].proposed);
    const line = s.drift.find((d: any) => d.positionId === filedAsset.id);
    expect(line).toMatchObject({ change: 'changed', filedProposed: '1595.63' });
    expect(line.fields).toEqual(expect.arrayContaining(['description', 'amount', 'proposedAmount', 'sources', 'evidence', 'asset']));
    expect(s.warnings[0]).toContain('changed since filed version 2');
    // The copyable report for the filed year is the filing, with the drift flagged
    const report = (await as(tokenA).get('/api/tax/years/2025-26/report').expect(200)).body;
    expect(report.version).toBe(2);
    expect(report.markdown).toContain('1595.63');
    expect(report.markdown).toContain('changed since filed version 2');

    // Each filing keeps what supported it, however the live records changed
    const v1 = (await as(tokenA).get('/api/tax/years/2025-26/filings/1').expect(200)).body;
    const asset = v1.positions.find((p: any) => p.source === 'ASSET');
    expect(asset.detail.evidence).toEqual([{ label: 'Invoice', url: 'https://drive.example.com/invoices/dgx.pdf', kind: 'INVOICE' }]);
    expect(asset.detail.sources).toEqual([expect.objectContaining({ transactionId: sparkTx.id, description: 'DGX Spark', amount: '6249.00', accountName: 'Everyday' })]);
    expect(asset.detail.asset).toMatchObject({ name: 'NVIDIA DGX Spark', cost: '6249.00', method: 'DIMINISHING_VALUE', effectiveLifeYears: '4', firstUsedOn: '2025-11-10', openingValue: '6249.00', daysHeld: 233 });
    const donation = (await as(tokenA).get('/api/tax/years/2025-26/filings/2').expect(200)).body.positions.find((p: any) => p.description === 'Donation');
    expect(donation.detail).toMatchObject({ rationale: null, sources: [], evidence: [], asset: null });

    // Unlinking the source after filing: the filing still names it
    const linkId = (await as(tokenA).get(`/api/tax/assets/${sparkId}`).expect(200)).body.links[0].id;
    await as(tokenA).delete(`/api/tax/links/${linkId}`).expect(200);
    const v1again = (await as(tokenA).get('/api/tax/years/2025-26/filings/1').expect(200)).body;
    expect(v1again.positions.find((p: any) => p.source === 'ASSET').detail.sources).toHaveLength(1);

    // Put the live records back
    await as(tokenA).post('/api/tax/links', { assetId: sparkId, transactionId: sparkTx.id }).expect(201);
    await as(tokenA).patch(`/api/transactions/${sparkTx.id}`, { description: 'DGX Spark' }).expect(200);
    await as(tokenA).post('/api/tax/evidence', { assetId: sparkId, label: 'Invoice', url: 'https://drive.example.com/invoices/dgx.pdf', kind: 'INVOICE' }).expect(201);
    await as(tokenA).patch(`/api/tax/assets/${sparkId}`, { cost: '6249', name: 'NVIDIA DGX Spark' }).expect(200);
    expect((await as(tokenA).get('/api/tax/years/2025-26').expect(200)).body.drift).toEqual([]);
  });

  it('serializes linking one transaction from concurrent requests: exactly one of an item and an asset wins', async () => {
    const tx = (await as(tokenA).post(`/api/accounts/${bank.id}/transactions`, { type: 'WITHDRAWAL', date: '2026-08-05', currency: 'AUD', amount: '450' }).expect(201)).body;
    const item = (await as(tokenA).post('/api/tax/items', { description: 'Race item', amount: '450' }).expect(201)).body;
    const asset = (await as(tokenA).post('/api/tax/assets', { name: 'Race asset', cost: '450', acquiredOn: '2026-08-05', firstUsedOn: '2026-08-05', method: 'IMMEDIATE' }).expect(201)).body;
    const results = await Promise.all([
      as(tokenA).post('/api/tax/links', { itemId: item.id, transactionId: tx.id }),
      as(tokenA).post('/api/tax/links', { assetId: asset.id, transactionId: tx.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    await as(tokenA).delete(`/api/tax/items/${item.id}`).expect(200);
    await as(tokenA).delete(`/api/tax/assets/${asset.id}`).expect(200);
    await as(tokenA).delete(`/api/transactions/${tx.id}`).expect(200);
  });

  it('flags a transaction shared by two assets on every year\'s asset positions', async () => {
    const tx = (await as(tokenA).post(`/api/accounts/${bank.id}/transactions`, { type: 'WITHDRAWAL', date: '2026-08-06', currency: 'AUD', amount: '3000' }).expect(201)).body;
    const a = (await as(tokenA).post('/api/tax/assets', { name: 'Desk', cost: '1000', acquiredOn: '2026-08-06', firstUsedOn: '2026-08-06', method: 'PRIME_COST', effectiveLifeYears: '5', links: [{ transactionId: tx.id }] }).expect(201)).body;
    const b = (await as(tokenA).post('/api/tax/assets', { name: 'Chair', cost: '2000', acquiredOn: '2026-08-06', firstUsedOn: '2026-08-06', method: 'PRIME_COST', effectiveLifeYears: '5' }).expect(201)).body;
    await as(tokenA).post('/api/tax/links', { assetId: b.id, transactionId: tx.id }).expect(409);
    await as(tokenA).post('/api/tax/links', { assetId: b.id, transactionId: tx.id, allowShared: true }).expect(201);
    for (const year of ['2026-27', '2027-28']) {
      const s = (await as(tokenA).get(`/api/tax/years/${year}`).expect(200)).body;
      for (const id of [a.id, b.id]) expect(s.positions.find((p: any) => p.id === `asset:${id}:${year}`).gaps).toContain('shared-transaction');
      expect(s.warnings.join(' ')).toContain('share a linked transaction');
    }
    for (const id of [a.id, b.id]) await as(tokenA).delete(`/api/tax/assets/${id}`).expect(200);
    await as(tokenA).delete(`/api/transactions/${tx.id}`).expect(200);
  });

  it('an asset written off and sold in a later year still reports the sale\'s balancing adjustment', async () => {
    const asset = (await as(tokenA).post('/api/tax/assets', { name: 'Camera', cost: '3000', acquiredOn: '2024-07-10', firstUsedOn: '2024-07-10', method: 'IMMEDIATE', defaultUsePercent: '80' }).expect(201)).body;
    const sold = (await as(tokenA).patch(`/api/tax/assets/${asset.id}`, { disposedOn: '2026-03-15', disposalProceeds: '1000' }).expect(200)).body;
    expect(sold.lifecycle).toBe('DISPOSED');
    expect(sold.schedule.rows.map((r: any) => [r.taxYear, r.decline])).toEqual([
      ['2024-25', '3000.00'],
      ['2025-26', '0.00'],
    ]);
    // 2025-26 is filed, so the sale shows in its live recomputation and as drift
    const filed = (await as(tokenA).get('/api/tax/years/2025-26').expect(200)).body;
    const camera = filed.live.positions.filter((p: any) => p.assetId === asset.id);
    expect(camera).toEqual([expect.objectContaining({ id: `asset:${asset.id}:2025-26:balancing`, kind: 'INCOME', amount: '1000.00', proposedAmount: '800.00' })]);
    expect(filed.drift).toEqual([expect.objectContaining({ change: 'added', positionId: `asset:${asset.id}:2025-26:balancing` })]);
    const years = (await as(tokenA).get('/api/tax/years').expect(200)).body.years.map((y: any) => y.taxYear);
    expect(years).toEqual(expect.arrayContaining(['2024-25', '2025-26']));
    await as(tokenA).delete(`/api/tax/assets/${asset.id}`).expect(200);
  });

  it('filters and searches items', async () => {
    const found = (await as(tokenA).get('/api/tax/items?q=current%20work').expect(200)).body.items;
    expect(found.map((i: any) => i.id)).toEqual([ticketId]);
    expect((await as(tokenA).get('/api/tax/items?category=donations').expect(200)).body.items).toHaveLength(1);
    expect((await as(tokenA).get('/api/tax/items?evidence=present').expect(200)).body.items.map((i: any) => i.id)).toEqual([ticketId]);
    expect((await as(tokenA).get('/api/tax/items?source=unlinked&taxYear=2025-26').expect(200)).body.items).toHaveLength(2);
  });

  it('records disposal with an estimated balancing adjustment as a separate position', async () => {
    const asset = (await as(tokenA).post('/api/tax/assets', { name: 'Old laptop', cost: '2000', acquiredOn: '2026-07-01', firstUsedOn: '2026-07-01', method: 'PRIME_COST', effectiveLifeYears: '2' }).expect(201)).body;
    const disposed = (await as(tokenA).patch(`/api/tax/assets/${asset.id}`, { disposedOn: '2027-06-30', disposalProceeds: '1200' }).expect(200)).body;
    expect(disposed.lifecycle).toBe('DISPOSED');
    expect(disposed.schedule.rows).toEqual([expect.objectContaining({ taxYear: '2026-27', decline: '1000.00', balancingAdjustment: expect.objectContaining({ amount: '200.00' }) })]);
    const s = (await as(tokenA).get('/api/tax/years/2026-27').expect(200)).body;
    expect(s.positions.find((p: any) => p.id === `asset:${asset.id}:2026-27:balancing`)).toMatchObject({ kind: 'INCOME', proposedAmount: '200.00' });
    await as(tokenA).delete(`/api/tax/assets/${asset.id}`).expect(200);
  });

  it('deleting a linked transaction leaves the item in place, unmatched again', async () => {
    const tx = (await as(tokenA).post(`/api/accounts/${bank.id}/transactions`, { type: 'WITHDRAWAL', date: '2026-08-01', currency: 'AUD', amount: '25' }).expect(201)).body;
    const item = (await as(tokenA).post('/api/tax/items', { description: 'Union fee', links: [{ transactionId: tx.id }] }).expect(201)).body;
    expect(item).toMatchObject({ effectiveAmount: '25.00', taxYear: '2026-27' });
    await as(tokenA).delete(`/api/transactions/${tx.id}`).expect(200);
    const after = (await as(tokenA).get(`/api/tax/items/${item.id}`).expect(200)).body;
    expect(after.links).toEqual([]);
    expect(after.gaps).toEqual(expect.arrayContaining(['no-transaction', 'no-amount']));
    await as(tokenA).delete(`/api/tax/items/${item.id}`).expect(200);
  });

  it('validates asset inputs without assuming an effective life', async () => {
    const res = await as(tokenA).post('/api/tax/assets', { name: 'Monitor', cost: '500', acquiredOn: '2026-07-01', method: 'PRIME_COST' }).expect(400);
    expect(res.body.error.message).toContain('effectiveLifeYears');
    await as(tokenA).post('/api/tax/assets', { name: 'Monitor', cost: '500', acquiredOn: '2026-07-01', firstUsedOn: '2026-06-01', method: 'IMMEDIATE' }).expect(400);
  });

  it('keeps every user\'s tax records apart: another user\'s records answer 404', async () => {
    await as(tokenB).get(`/api/tax/items/${ticketId}`).expect(404);
    await as(tokenB).patch(`/api/tax/items/${ticketId}`, { claimPercent: '10' }).expect(404);
    await as(tokenB).get(`/api/tax/assets/${sparkId}`).expect(404);
    await as(tokenB).put(`/api/tax/assets/${sparkId}/years/2026-27`, { usePercent: '10' }).expect(404);
    const mine = (await as(tokenB).post('/api/tax/items', { description: 'B item', amount: '1' }).expect(201)).body;
    await as(tokenB).post('/api/tax/links', { itemId: mine.id, transactionId: ticketTx.id }).expect(404);
    await as(tokenB).post('/api/tax/links', { itemId: ticketId, transactionId: ticketTx.id }).expect(404);
    await as(tokenB).post('/api/tax/evidence', { assetId: sparkId, label: 'x', url: 'https://example.com' }).expect(404);
    const links = (await as(tokenA).get(`/api/tax/items/${ticketId}`).expect(200)).body.links;
    await as(tokenB).delete(`/api/tax/links/${links[0].id}`).expect(404);
    expect((await as(tokenB).get('/api/tax/items').expect(200)).body.items.map((i: any) => i.description)).toEqual(['B item']);
    expect((await as(tokenB).get('/api/tax/years/2025-26').expect(200)).body.positions).toEqual([]);
    await as(tokenB).get('/api/tax/years/2025-26/filings/1').expect(404);
    await t.http.get('/api/tax/items').expect(401);
  });

  it('works from MCP: remember, review and summarise', async () => {
    const created = await callTool(t, mcpA, 'create_tax_item', { description: 'GPU cloud credits', date: '2026-10-01', amount: 120, claimPercent: 100, category: 'work-related-expenses' });
    expect(created.isError).toBe(false);
    expect(created.data).toMatchObject({ taxYear: '2026-27', proposedAmount: '120.00' });
    const updated = await callTool(t, mcpA, 'update_tax_item', { itemId: created.data.id, claimPercent: '50', status: 'CONFIRMED' });
    expect(updated.data).toMatchObject({ proposedAmount: '60.00', status: 'CONFIRMED' });
    const summary = await callTool(t, mcpA, 'get_tax_year_summary', { taxYear: '2026-27' });
    expect(summary.data.positions.map((p: any) => p.description)).toEqual(expect.arrayContaining(['AI Engineering Conference ticket', 'GPU cloud credits', 'Decline in value: NVIDIA DGX Spark (estimate)']));
    const schedule = await callTool(t, mcpA, 'get_depreciation_schedule', { assetId: sparkId, throughYear: '2026-27' });
    expect(schedule.data.rows.map((r: any) => r.deduction)).toEqual(['1595.63', '1276.34']);
    const refused = await callTool(t, mcpA, 'link_tax_transaction', { itemId: created.data.id, transactionId: sparkTx.id });
    expect(refused).toMatchObject({ isError: true, data: { error: { code: 'conflict' } } });
    const notFound = await callTool(t, mcpA, 'get_tax_item', { itemId: 'not-a-uuid' });
    expect(notFound.data.error.code).toBe('not_found');
    const report = await callTool(t, mcpA, 'get_tax_year_report', { taxYear: '2026-27' });
    expect(report.data.markdown).toContain('GPU cloud credits');
  });

  it('migration down and up again keeps the rest of the schema intact', async () => {
    await undoMigrationsThrough(ds, 'TaxLedger1762500000000');
    const [{ exists }] = await ds.query(`SELECT to_regclass('tax_items') IS NOT NULL AS exists`);
    expect(exists).toBe(false);
    await ds.runMigrations();
    const [{ again }] = await ds.query(`SELECT to_regclass('tax_items') IS NOT NULL AS again`);
    expect(again).toBe(true);
    expect((await as(tokenA).get('/api/tax/items').expect(200)).body.items).toEqual([]);
  });
});
