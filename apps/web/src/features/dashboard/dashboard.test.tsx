import type { Dashboard, ReportTotals } from '@money/client';
import { screen, within } from '@testing-library/react';
import { apiError, fakeClient, renderApp } from '../../test/render';

const totals = (display: string | null, total: string, byCurrency: { currency: string; total: string }[], holdings = '0'): ReportTotals => ({
  byCurrency: byCurrency.map((t) => ({ currency: t.currency, cash: t.total, holdings: '0', total: t.total })),
  converted: display ? { baseCurrency: display, cash: total, holdings, total } : null,
});

/** A dashboard as the backend returns it; `converted: false` mimics a missing USD rate */
function dashboardFixture({ display = 'AUD', converted = true }: { display?: string; converted?: boolean } = {}): Dashboard {
  const c = converted ? display : null;
  const pct = (v: string) => (converted ? v : null);
  return {
    asOf: '2026-10-22T00:00:00.000Z',
    displayCurrency: display,
    priceProvider: 'mock',
    fx: converted
      ? { displayCurrency: display, complete: true, rates: [{ currency: 'USD', rate: '1.5', source: 'market', provider: 'mock', asOf: '2026-10-22T00:00:00.000Z', isMock: true }], missing: [] }
      : { displayCurrency: display, complete: false, rates: [], missing: [{ currency: 'USD', reason: 'No USD→AUD exchange rate from provider yahoo' }] },
    valuation: { status: converted ? 'COMPLETE' : 'PARTIAL', usesMockPrices: true, holdings: 2, marketPriced: 0, stalePriced: 0, mockPriced: 2, costFallback: 0, oldestPriceAsOf: null, stalePriceDays: 5 },
    total: totals(c, '1000', [{ currency: 'AUD', total: '700' }, { currency: 'USD', total: '200' }]),
    assetClasses: [
      { assetClass: 'cash', totals: totals(c, '400', [{ currency: 'AUD', total: '400' }]), percentOfTotal: pct('40'), accounts: [{ accountId: 'bank', accountPath: ['Bank'], totals: totals(c, '400', [{ currency: 'AUD', total: '400' }]), percentOfClass: pct('100') }] },
      { assetClass: 'shares', totals: totals(c, '300', [{ currency: 'USD', total: '200' }]), percentOfTotal: pct('30'), accounts: [] },
      { assetClass: 'super', totals: totals(c, '300', [{ currency: 'AUD', total: '300' }]), percentOfTotal: pct('30'), accounts: [] },
    ],
    categories: [
      { category: { id: 'cat-ef', name: 'Emergency fund', color: '#336699' }, totals: totals(c, '400', [{ currency: 'AUD', total: '400' }]), percentOfTotal: pct('40'), items: [] },
      { category: { id: 'cat-crypto', name: 'Crypto', color: null }, totals: totals(c, '0', []), percentOfTotal: pct('0'), items: [] },
      { category: null, totals: totals(c, '600', [{ currency: 'AUD', total: '300' }, { currency: 'USD', total: '200' }]), percentOfTotal: pct('60'), items: [] },
    ],
    accounts: [
      { id: 'bank', name: 'Bank', type: 'CASH', subaccounts: 1, totals: totals(c, '400', [{ currency: 'AUD', total: '400' }]), percentOfTotal: pct('40') },
      { id: 'super', name: 'AustralianSuper', type: 'SUPERANNUATION', subaccounts: 0, totals: totals(c, '300', [{ currency: 'AUD', total: '300' }]), percentOfTotal: pct('30') },
    ],
    shares: {
      totals: totals(c, '300', [{ currency: 'USD', total: '200' }], '300'),
      percentOfTotal: pct('30'),
      tickers: [
        {
          symbol: 'VOO',
          currency: 'USD',
          quantity: '12',
          value: '150',
          convertedValue: converted ? '225' : null,
          percentOfShares: pct('75'),
          percentOfTotal: pct('22.5'),
          priceStatus: 'MOCK',
          price: { price: '12.5', asOf: '2026-10-22T00:00:00.000Z', source: 'mock', isMock: true },
          positions: [
            { accountId: 'stake', accountPath: ['Stake'], quantity: '10', value: '125', basis: 'market' },
            { accountId: 'ibkr', accountPath: ['IBKR'], quantity: '2', value: '25', basis: 'market' },
          ],
        },
        {
          symbol: 'TSLA',
          currency: 'USD',
          quantity: '1',
          value: '50',
          convertedValue: converted ? '75' : null,
          percentOfShares: pct('25'),
          percentOfTotal: pct('7.5'),
          priceStatus: 'COST_FALLBACK',
          price: null,
          positions: [{ accountId: 'stake', accountPath: ['Stake'], quantity: '1', value: '50', basis: 'cost' }],
        },
      ],
    },
    warnings: ['Some prices are mock (made-up development data, isMock: true). Do not rely on these valuations.'],
    notes: [],
  };
}

function clientWith(dashboard: Dashboard) {
  const client = fakeClient();
  client.dashboard.getDashboard.mockResolvedValue(dashboard);
  client.valuations.getValuationHistory.mockResolvedValue({ fromDate: '2026-07-01', toDate: '2026-10-21', accountId: null, includeSubaccounts: true, symbol: null, fx: null, days: [], notes: [] });
  return client;
}

describe('dashboard', () => {
  it('is the home page and shows a loading state', async () => {
    renderApp('/');
    expect(await screen.findByText('Loading your dashboard…')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('shows total assets split by asset class and account, with the data quality', async () => {
    const client = clientWith(dashboardFixture());
    renderApp('/dashboard', { client });
    expect(await screen.findByRole('heading', { name: /1,000\.00\s*AUD/ })).toBeInTheDocument();
    expect(client.dashboard.getDashboard).toHaveBeenCalledWith(expect.objectContaining({ displayCurrency: 'AUD', fxRates: undefined }));
    const classes = screen.getByRole('region', { name: 'Asset classes' });
    expect(within(classes).getByText('Super (retirement)')).toBeInTheDocument();
    expect(within(classes).getAllByText('40%').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: /Asset classes: Cash 40%, Shares 30%, Super \(retirement\) 30%/ })).toBeInTheDocument();
    const accounts = screen.getByRole('region', { name: 'Top-level accounts' });
    expect(within(accounts).getByRole('link', { name: 'AustralianSuper' })).toHaveAttribute('href', '/accounts/super');
    expect(screen.getByText('Complete valuation')).toBeInTheDocument();
    expect(screen.getByText('Includes mock data')).toBeInTheDocument();
    expect(screen.getByText(/mock rate/)).toBeInTheDocument();
  });

  it('switches the display currency through the backend', async () => {
    const client = clientWith(dashboardFixture());
    const { user } = renderApp('/dashboard', { client });
    await screen.findByRole('heading', { name: /1,000\.00\s*AUD/ });
    client.dashboard.getDashboard.mockResolvedValue(dashboardFixture({ display: 'USD' }));
    await user.click(screen.getByLabelText('USD'));
    expect(await screen.findByRole('heading', { name: /1,000\.00\s*USD/ })).toBeInTheDocument();
    expect(client.dashboard.getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ displayCurrency: 'USD' }));
  });

  it('never adds currencies together when a rate is missing, and accepts a manual rate', async () => {
    const client = clientWith(dashboardFixture({ converted: false }));
    const { user } = renderApp('/dashboard', { client });
    expect(await screen.findByText(/No exchange rate for USD/)).toBeInTheDocument();
    expect(screen.getByText(/Not converted to AUD/)).toBeInTheDocument();
    expect(screen.getByText('Partial valuation')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Asset classes/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Needs an exchange rate for every currency to chart/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use these rates' }));
    expect(screen.getByText('Enter a positive rate for each currency, e.g. 1.52.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('AUD per 1 USD'), '1.5');
    await user.click(screen.getByRole('button', { name: 'Use these rates' }));
    expect(client.dashboard.getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ displayCurrency: 'AUD', fxRates: 'USD:1.5' }));
  });

  it('shows each share with both concentration denominators and price status', async () => {
    const client = clientWith(dashboardFixture());
    renderApp('/dashboard/shares', { client });
    const table = await screen.findByRole('region', { name: 'Shares' });
    expect(within(table).getByText('% of shares')).toBeInTheDocument();
    expect(within(table).getByText('% of total assets')).toBeInTheDocument();
    expect(within(table).getByText('75%')).toBeInTheDocument();
    expect(within(table).getByText('22.5%')).toBeInTheDocument();
    expect(within(table).getByText('2 accounts')).toBeInTheDocument();
    expect(within(table).getByText('At cost, no price')).toBeInTheDocument();
    expect(within(table).getByText('Mock price')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Concentration by share: VOO 75%, TSLA 25%/ })).toBeInTheDocument();
  });

  it('lists every custom category, including empty ones', async () => {
    const client = clientWith(dashboardFixture());
    renderApp('/dashboard/categories', { client });
    const table = await screen.findByRole('region', { name: 'Categories' });
    expect(within(table).getByText('Emergency fund')).toBeInTheDocument();
    expect(within(table).getByText('Crypto')).toBeInTheDocument();
    expect(within(table).getByText('Uncategorized')).toBeInTheDocument();
    expect(within(table).getAllByText('Nothing assigned').length).toBe(3);
  });

  it('offers to create an account when there is nothing to show', async () => {
    const empty = { ...dashboardFixture(), accounts: [], assetClasses: [], categories: [], shares: { ...dashboardFixture().shares, tickers: [] } };
    renderApp('/dashboard', { client: clientWith(empty) });
    expect(await screen.findByText('Nothing to show yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/accounts/new');
  });

  it('shows an error, and lets the user drop rejected manual rates', async () => {
    const client = fakeClient();
    client.dashboard.getDashboard.mockRejectedValue(apiError(400, 'validation_failed', 'rate for USD must be a positive decimal'));
    const { user } = renderApp('/dashboard?rates=USD:-1', { client });
    expect(await screen.findByText('rate for USD must be a positive decimal')).toBeInTheDocument();
    client.dashboard.getDashboard.mockResolvedValue(dashboardFixture());
    client.valuations.getValuationHistory.mockResolvedValue({ fromDate: '2026-07-01', toDate: '2026-10-21', accountId: null, includeSubaccounts: true, symbol: null, fx: null, days: [], notes: [] });
    await user.click(screen.getByRole('button', { name: 'Clear manual rates' }));
    expect(await screen.findByRole('heading', { name: /1,000\.00\s*AUD/ })).toBeInTheDocument();
    expect(client.dashboard.getDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ fxRates: undefined }));
  });
});
