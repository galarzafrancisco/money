import { screen, within } from '@testing-library/react';
import { account, accountsReport, category, reportNode } from '../../test/fixtures';
import { apiError, fakeClient, renderApp } from '../../test/render';

describe('accounts list', () => {
  it('shows an empty state that leads to the wizard', async () => {
    renderApp('/accounts');
    expect(await screen.findByText('No accounts yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create your first account' })).toHaveAttribute('href', '/accounts/new');
  });

  it('lists accounts as a tree with per-currency totals that are never summed', async () => {
    const client = fakeClient();
    const parent = account({ id: 'p', name: 'Savings', type: 'CASH' });
    const child = account({ id: 'c', name: 'Emergency fund', type: 'CASH', parentAccountId: 'p' });
    client.accounts.listAccounts.mockResolvedValue([child, parent]);
    client.reports.getAccountsReport.mockResolvedValue(
      accountsReport([
        reportNode(parent, [{ currency: 'AUD', total: '100' }], [
          { currency: 'AUD', total: '1100' },
          { currency: 'USD', total: '50' },
        ], [reportNode(child, [{ currency: 'AUD', total: '1000' }])]),
      ]),
    );
    renderApp('/accounts', { client });

    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]).getByRole('link', { name: 'Savings' })).toHaveAttribute('href', '/accounts/p');
    expect(within(rows[1]).getByRole('link', { name: 'Emergency fund' })).toBeInTheDocument();
    // The parent's rolled-up figure, one line per currency, no cross-currency total
    expect(await within(rows[0]).findByText('1,100.00')).toBeInTheDocument();
    expect(within(rows[0]).getByText('50.00')).toBeInTheDocument();
    expect(within(rows[0]).getByText('incl. subaccounts')).toBeInTheDocument();
    expect(within(rows[1]).getByText('1,000.00')).toBeInTheDocument();
    expect(screen.queryByText('1,150.00')).not.toBeInTheDocument();
    expect(screen.getByText(/mock prices, not real market data/)).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    const client = fakeClient();
    client.accounts.listAccounts.mockRejectedValue(apiError(503, 'auth_unavailable', 'Taico unreachable'));
    renderApp('/accounts', { client });
    // A 5xx is retried once before the error shows
    expect(await screen.findByText('Could not load your accounts', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('Taico unreachable')).toBeInTheDocument();
  });
});

describe('new account wizard', () => {
  it('validates each step, reviews, then creates the account', async () => {
    const client = fakeClient();
    client.accounts.listAccounts.mockResolvedValue([account({ id: 'p', name: 'Savings', type: 'CASH', reportingCurrency: 'USD' })]);
    client.categories.listCategories.mockResolvedValue([category()]);
    client.accounts.createAccount.mockResolvedValue(account({ id: 'new', name: 'Emergency fund' }));
    const { user } = renderApp('/accounts/new', { client });

    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(screen.getByText('Give the account a name.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), 'Emergency fund');
    await user.click(screen.getByLabelText('Cash'));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    await user.selectOptions(screen.getByLabelText('Inside another account'), 'p');
    // Defaults to the parent's currency
    expect(screen.getByLabelText('Reporting currency')).toHaveValue('USD');
    await user.clear(screen.getByLabelText('Reporting currency'));
    await user.type(screen.getByLabelText('Reporting currency'), 'A1');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Use a 3-letter currency code, e.g. AUD or USD.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Reporting currency'));
    await user.type(screen.getByLabelText('Reporting currency'), 'aud');
    await user.selectOptions(screen.getByLabelText('Category'), 'cat-1');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByText('Review', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Savings')).toBeInTheDocument();
    expect(screen.getByText('Core')).toBeInTheDocument();
    expect(client.accounts.createAccount).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(client.accounts.createAccount).toHaveBeenCalledWith({
      body: { name: 'Emergency fund', type: 'CASH', reportingCurrency: 'AUD', parentAccountId: 'p', categoryId: 'cat-1' },
    });
    expect(await screen.findByText('Emergency fund is ready')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open account' })).toHaveAttribute('href', '/accounts/new');
    expect(screen.getByRole('link', { name: 'Record a deposit' })).toHaveAttribute('href', '/accounts/new/record?type=DEPOSIT');
  });

  it('explains a name conflict and lets the user go back', async () => {
    const client = fakeClient();
    client.accounts.createAccount.mockRejectedValue(apiError(409, 'conflict', 'An account named "Broker" already exists here'));
    const { user } = renderApp('/accounts/new', { client });
    await user.type(await screen.findByLabelText('Name'), 'Broker');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('An account named "Broker" already exists here')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change the name' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Broker');
  });
});
