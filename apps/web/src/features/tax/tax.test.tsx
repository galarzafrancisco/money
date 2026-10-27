import type { DepreciationRow, TaxAsset, TaxItem, TaxPosition, TaxYearSummary } from '@money/client';
import { screen, within } from '@testing-library/react';
import { apiError, fakeClient, renderApp } from '../../test/render';

const now = '2026-10-21T00:00:00.000Z';

function item(overrides: Partial<TaxItem> = {}): TaxItem {
  return {
    id: 'item-1',
    taxYear: '2026-27',
    kind: 'DEDUCTION',
    category: 'self-education',
    description: 'AI Engineering Conference ticket',
    date: '2026-09-10',
    currency: 'AUD',
    amount: '899.00',
    amountSource: 'entered',
    effectiveAmount: '899.00',
    claimPercent: '50',
    proposedAmount: '449.50',
    claimedAmount: null,
    status: 'TO_REVIEW',
    rationale: 'Relates to my current work',
    notes: null,
    links: [],
    evidence: [],
    gaps: ['needs-review', 'no-evidence', 'no-transaction'],
    yearStatus: 'PREPARING',
    locked: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function position(overrides: Partial<TaxPosition> = {}): TaxPosition {
  return {
    id: 'item-1',
    source: 'ITEM',
    itemId: 'item-1',
    assetId: null,
    kind: 'DEDUCTION',
    category: 'self-education',
    description: 'AI Engineering Conference ticket',
    date: '2026-09-10',
    currency: 'AUD',
    amount: '899.00',
    percent: '50',
    proposedAmount: '449.50',
    claimedAmount: null,
    status: 'TO_REVIEW',
    linkCount: 1,
    evidenceCount: 0,
    gaps: ['needs-review', 'no-evidence'],
    workings: null,
    ...overrides,
  };
}

function summary(overrides: Partial<TaxYearSummary> = {}): TaxYearSummary {
  const positions = [
    position(),
    position({ id: 'asset:a1:2026-27', source: 'ASSET', itemId: null, assetId: 'a1', category: 'depreciating-assets', description: 'Decline in value: NVIDIA DGX Spark (estimate)', amount: '2127.23', percent: '60', proposedAmount: '1276.34', gaps: ['needs-review'] }),
  ];
  return {
    taxYear: '2026-27',
    jurisdiction: 'AU',
    period: { start: '2026-07-01', end: '2027-06-30', days: 365 },
    status: 'PREPARING',
    basis: 'LIVE',
    filedVersion: null,
    notes: null,
    amendingReason: null,
    positions,
    totals: {
      byKind: [{ kind: 'DEDUCTION', currency: 'AUD', count: 2, proposed: '1725.84', confirmed: '0.00', claimed: '0.00' }],
      byCategory: [
        { kind: 'DEDUCTION', category: 'depreciating-assets', currency: 'AUD', count: 1, proposed: '1276.34', confirmed: '0.00', claimed: '0.00' },
        { kind: 'DEDUCTION', category: 'self-education', currency: 'AUD', count: 1, proposed: '449.50', confirmed: '0.00', claimed: '0.00' },
      ],
    },
    gaps: { counts: { 'needs-review': 2, 'no-evidence': 1 }, positions: [] },
    gapDescriptions: { 'no-evidence': 'No evidence link (receipt, invoice or calculation)' },
    warnings: [],
    live: null,
    drift: [],
    filings: [],
    rulesVersion: 'au-decline-in-value/2026.1',
    disclaimers: [],
    ...overrides,
  };
}

function row(overrides: Partial<DepreciationRow> = {}): DepreciationRow {
  return {
    taxYear: '2025-26',
    startYear: 2025,
    periodStart: '2025-11-10',
    periodEnd: '2026-06-30',
    daysHeld: 233,
    daysInYear: 365,
    openingValue: '6249.00',
    decline: '1994.54',
    closingValue: '4254.46',
    usePercent: '80',
    usePercentSource: 'default',
    deduction: '1595.63',
    privatePortion: '398.91',
    balancingAdjustment: null,
    workings: 'Diminishing value: opening value 6249.00 × 50% × 233/365 days = 1994.54; deduction at 80% work use = 1595.63.',
    yearStatus: 'PREPARING',
    review: { status: 'TO_REVIEW', claimedAmount: null, balancingClaimedAmount: null, note: null, usePercentOverride: null },
    filed: null,
    driftFromFiled: false,
    ...overrides,
  };
}

function asset(rows: DepreciationRow[]): TaxAsset {
  return {
    id: 'a1',
    name: 'NVIDIA DGX Spark',
    description: null,
    category: 'depreciating-assets',
    currency: 'AUD',
    cost: '6249.00',
    acquiredOn: '2025-11-03',
    firstUsedOn: '2025-11-10',
    method: 'DIMINISHING_VALUE',
    effectiveLifeYears: '4',
    ratePercent: null,
    defaultUsePercent: '80',
    ownership: 'Owned by me',
    disposedOn: null,
    disposalProceeds: null,
    notes: null,
    lifecycle: 'IN_USE',
    adjustableValue: rows.at(-1)?.closingValue ?? '6249.00',
    links: [],
    evidence: [],
    gaps: ['no-transaction'],
    createdAt: now,
    updatedAt: now,
    schedule: {
      rulesVersion: 'au-decline-in-value/2026.1',
      method: 'DIMINISHING_VALUE',
      ratePercent: '50',
      rateSource: 'effective-life',
      firstYear: '2025-26',
      endReason: 'HORIZON',
      totals: { decline: '4121.77', deduction: '2871.97', privatePortion: '1249.80' },
      throughYear: '2026-27',
      rows,
      notes: ['Estimates from your own inputs.'],
    },
  };
}

describe('tax', () => {
  it('shows a year with items and asset depreciation, totals and open questions', async () => {
    const client = fakeClient();
    client.tax.getTaxYear.mockResolvedValue(summary());
    renderApp('/tax/years/2026-27', { client });
    const table = await screen.findByRole('region', { name: 'Positions for 2026-27' });
    expect(within(table).getByRole('link', { name: 'AI Engineering Conference ticket' })).toHaveAttribute('href', '/tax/items/item-1');
    expect(within(table).getByRole('link', { name: /DGX Spark/ })).toHaveAttribute('href', '/tax/assets/a1');
    expect(screen.getByText('1,725.84')).toBeInTheDocument();
    expect(screen.getByText('2 position(s) still to review.')).toBeInTheDocument();
    expect(screen.getByText(/No evidence link/)).toBeInTheDocument();
    expect(screen.getAllByText(/not tax advice/).length).toBeGreaterThan(0);
    expect(client.tax.getTaxYear).toHaveBeenCalledWith(expect.objectContaining({ taxYear: '2026-27' }));
  });

  it('remembers a new item with intent and rationale, sending strings only', async () => {
    const client = fakeClient();
    client.tax.createTaxItem.mockResolvedValue(item());
    client.tax.getTaxItem.mockResolvedValue(item());
    const { user } = renderApp('/tax/items/new', { client });
    await user.type(await screen.findByLabelText('What is it?'), 'AI Engineering Conference ticket');
    await user.type(screen.getByLabelText(/^Category/), 'self-education');
    await user.type(screen.getByLabelText(/^Amount/), '899');
    await user.clear(screen.getByLabelText(/^Claim %/));
    await user.type(screen.getByLabelText(/^Claim %/), '150');
    await user.click(screen.getByRole('button', { name: 'Save item' }));
    expect(screen.getByText('Use a percentage from 0 to 100.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/^Claim %/));
    await user.type(screen.getByLabelText(/^Claim %/), '100');
    await user.type(screen.getByLabelText('Why you intend to claim it'), 'Relates to my current work');
    await user.click(screen.getByRole('button', { name: 'Save item' }));
    expect(client.tax.createTaxItem).toHaveBeenCalledWith({
      body: expect.objectContaining({ taxYear: '2026-27', kind: 'DEDUCTION', category: 'self-education', description: 'AI Engineering Conference ticket', amount: '899', claimPercent: '100', currency: 'AUD', rationale: 'Relates to my current work' }),
    });
    expect(await screen.findByText('449.50')).toBeInTheDocument();
  });

  it('links a transaction found by search, and adds an evidence URL', async () => {
    const client = fakeClient();
    client.tax.getTaxItem.mockResolvedValue(item());
    client.search.searchTransactions.mockResolvedValue({
      items: [{ id: 'tx-1', accountId: 'acc', merchant: null, merchantKey: null, date: '2026-09-12', amount: '-899', direction: 'out', currency: 'AUD', status: 'SETTLED', transfer: false, note: 'AI Engineering Conference', source: 'manual', type: 'WITHDRAWAL', reconciliation: null, matchedTransactionId: null }],
      nextOffset: null,
      summary: { totalCount: 1, byCurrency: [] },
    });
    client.tax.linkTaxTransaction.mockResolvedValue({});
    client.tax.addTaxEvidence.mockResolvedValue({});
    const { user } = renderApp('/tax/items/item-1', { client });
    await user.type(await screen.findByLabelText('Find a transaction to link'), 'conference');
    await user.click(await screen.findByRole('button', { name: 'Link' }));
    expect(client.tax.linkTaxTransaction).toHaveBeenCalledWith({ body: { itemId: 'item-1', transactionId: 'tx-1' } });

    await user.type(screen.getByLabelText('Label'), 'Receipt');
    await user.type(screen.getByLabelText('URL'), 'file:///receipt.pdf');
    await user.click(screen.getByRole('button', { name: 'Add link' }));
    expect(screen.getByText('Use a web address starting with https://')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('URL'));
    await user.type(screen.getByLabelText('URL'), 'https://drive.example.com/r.pdf');
    await user.click(screen.getByRole('button', { name: 'Add link' }));
    expect(client.tax.addTaxEvidence).toHaveBeenCalledWith({ body: { itemId: 'item-1', label: 'Receipt', url: 'https://drive.example.com/r.pdf', kind: 'RECEIPT' } });
  });

  it('shows the double-counting refusal from the backend', async () => {
    const client = fakeClient();
    client.tax.getTaxItem.mockResolvedValue(item());
    client.search.searchTransactions.mockResolvedValue({
      items: [{ id: 'tx-2', accountId: 'acc', merchant: null, merchantKey: null, date: '2025-11-03', amount: '-6249', direction: 'out', currency: 'AUD', status: 'SETTLED', transfer: false, note: 'DGX Spark', source: 'manual', type: 'WITHDRAWAL', reconciliation: null, matchedTransactionId: null }],
      nextOffset: null,
      summary: { totalCount: 1, byCurrency: [] },
    });
    client.tax.linkTaxTransaction.mockRejectedValue(apiError(409, 'conflict', 'That transaction pays for a registered depreciating asset.'));
    const { user } = renderApp('/tax/items/item-1', { client });
    await user.type(await screen.findByLabelText('Find a transaction to link'), 'spark');
    await user.click(await screen.findByRole('button', { name: 'Link' }));
    expect(await screen.findByText('That transaction pays for a registered depreciating asset.')).toBeInTheDocument();
  });

  it('a filed year\'s item is read-only', async () => {
    const client = fakeClient();
    client.tax.getTaxItem.mockResolvedValue(item({ yearStatus: 'FILED', locked: true }));
    renderApp('/tax/items/item-1', { client });
    expect(await screen.findByText(/part of a filed return and is read-only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Find a transaction to link')).not.toBeInTheDocument();
  });

  it('shows an asset\'s multi-year schedule and changes one year\'s work use', async () => {
    const client = fakeClient();
    const rows = [row(), row({ taxYear: '2026-27', startYear: 2026, periodStart: '2026-07-01', daysHeld: 365, openingValue: '4254.46', decline: '2127.23', closingValue: '2127.23', usePercent: '60', usePercentSource: 'year', deduction: '1276.34', review: { status: 'TO_REVIEW', claimedAmount: null, balancingClaimedAmount: null, note: null, usePercentOverride: '60' } })];
    client.tax.getTaxAsset.mockResolvedValue(asset(rows));
    client.tax.setTaxAssetYear.mockResolvedValue(asset(rows));
    const { user } = renderApp('/tax/assets/a1', { client });
    const table = await screen.findByRole('region', { name: 'Depreciation schedule' });
    expect(within(table).getByText('1,595.63')).toBeInTheDocument();
    expect(within(table).getByText('1,276.34')).toBeInTheDocument();
    expect(within(table).getByText('(this year)')).toBeInTheDocument();
    await user.click(within(table).getAllByRole('button', { name: 'Edit year' })[0]);
    await user.type(screen.getByLabelText('Work use % in 2025-26'), '90');
    await user.selectOptions(screen.getByLabelText('Review'), 'CONFIRMED');
    await user.click(screen.getByRole('button', { name: 'Save year' }));
    expect(client.tax.setTaxAssetYear).toHaveBeenCalledWith({ assetId: 'a1', taxYear: '2025-26', body: { usePercent: '90', status: 'CONFIRMED', claimedAmount: null } });
  });

  it('records the depreciation and the balancing adjustment actually claimed in a disposal year separately', async () => {
    const client = fakeClient();
    const disposal = row({
      closingValue: '0.00',
      balancingAdjustment: { terminationValue: '5000.00', adjustableValue: '4300.00', amount: '700.00', taxableAmount: '560.00' },
    });
    client.tax.getTaxAsset.mockResolvedValue(asset([disposal]));
    client.tax.setTaxAssetYear.mockResolvedValue(asset([disposal]));
    const { user } = renderApp('/tax/assets/a1', { client });
    const table = await screen.findByRole('region', { name: 'Depreciation schedule' });
    await user.click(within(table).getByRole('button', { name: 'Edit year' }));
    await user.type(screen.getByLabelText('Depreciation claimed'), '1595.63');
    await user.type(screen.getByLabelText('Balancing adjustment claimed'), '560');
    expect(screen.getByText('Returned as assessable income')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save year' }));
    expect(client.tax.setTaxAssetYear).toHaveBeenCalledWith({ assetId: 'a1', taxYear: '2025-26', body: { usePercent: null, status: 'TO_REVIEW', claimedAmount: '1595.63', balancingClaimedAmount: '560' } });
  });

  it('flags a filed year whose figure differs from the recomputed one', async () => {
    const client = fakeClient();
    client.tax.getTaxAsset.mockResolvedValue(asset([row({ yearStatus: 'FILED', filed: { version: 1, deduction: '1500.00' }, driftFromFiled: true })]));
    renderApp('/tax/assets/a1', { client });
    expect(await screen.findByText(/filed 1500.00 \(inputs changed since\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit year' })).not.toBeInTheDocument();
  });

  it('refuses an asset without an effective life or rate before calling the backend', async () => {
    const client = fakeClient();
    const { user } = renderApp('/tax/assets/new', { client });
    await user.type(await screen.findByLabelText('Name'), 'Monitor');
    await user.type(screen.getByLabelText(/^Cost/), '500');
    await user.type(screen.getByLabelText('Acquired on'), '2026-07-01');
    await user.click(screen.getByRole('button', { name: 'Register asset' }));
    expect(screen.getByText(/Money does not assume one/)).toBeInTheDocument();
    expect(client.tax.registerTaxAsset).not.toHaveBeenCalled();
  });

  it('records a lodgment and offers amendment once filed', async () => {
    const client = fakeClient();
    client.tax.getTaxYear.mockResolvedValue(summary({ status: 'FILED', basis: 'FILED', filedVersion: 1, drift: [{ positionId: 'asset:a1:2026-27', description: 'Decline in value: NVIDIA DGX Spark (estimate)', change: 'changed', fields: ['amount', 'proposedAmount', 'asset'], filedProposed: '1276.34', liveProposed: '1200.00' }], filings: [{ id: 'f1', version: 1, kind: 'ORIGINAL', filedOn: '2027-10-01', reference: 'R-1', note: null, amendmentReason: null, rulesVersion: 'x', positionCount: 2, totals: { byKind: [] }, createdAt: now }] }));
    client.tax.reopenTaxYear.mockResolvedValue(summary({ status: 'AMENDING' }));
    const { user } = renderApp('/tax/years/2026-27', { client });
    expect(await screen.findByRole('region', { name: 'Filing history' })).toBeInTheDocument();
    // A filed year shows its filed figures, and lists later changes apart
    expect(screen.getByRole('heading', { name: 'Totals as filed (version 1)' })).toBeInTheDocument();
    const drift = screen.getByRole('region', { name: 'Differences from the latest filing' });
    expect(drift).toHaveTextContent('Changed: amount, proposedAmount, asset');
    expect(drift).toHaveTextContent('1,200.00');
    await user.type(screen.getByLabelText('Reason for amending'), 'Missed a donation');
    await user.click(screen.getByRole('button', { name: 'Reopen for amendment' }));
    expect(client.tax.reopenTaxYear).toHaveBeenCalledWith({ taxYear: '2026-27', body: { reason: 'Missed a donation' } });
  });
});
