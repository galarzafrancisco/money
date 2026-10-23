import { screen } from '@testing-library/react';
import { apiError, fakeClient, renderApp } from '../../test/render';

const status = (over: object = {}) => ({
  configured: true, status: 'active', webhookStatus: 'registered', connectedAt: '2026-10-01T00:00:00Z', lastSyncAt: '2026-10-02T00:00:00Z', lastError: null,
  accounts: { total: 2, visible: 0, hidden: 2 }, hint: null, ...over,
});
const upAccount = (over: object = {}) => ({
  id: 'ua1', upId: 'u1', displayName: 'Emergency fund', accountType: 'SAVER', ownershipType: 'INDIVIDUAL', currency: 'AUD', balance: '1000.00',
  visible: false, linkedAccountId: null, categoryId: null, source: 'up', lastSyncedAt: null, removedAt: null, upCreatedAt: '2026-01-01T00:00:00Z', ...over,
});

describe('connections', () => {
  it('connects Up with a token, which is sent once and cleared', async () => {
    const client = fakeClient();
    client.up.connectUp.mockResolvedValue(status());
    const { user } = renderApp('/connections', { client });
    await user.type(await screen.findByLabelText('Up personal access token'), 'up:yeah:secret');
    await user.click(screen.getByRole('button', { name: 'Connect Up' }));
    expect(client.up.connectUp).toHaveBeenCalledWith({ body: { token: 'up:yeah:secret' } });
    expect(screen.queryByDisplayValue('up:yeah:secret')).not.toBeInTheDocument();
  });

  it('shows a rejected token error from the server', async () => {
    const client = fakeClient();
    client.up.connectUp.mockRejectedValue(apiError(422, 'credential_rejected', 'Up rejected that token'));
    const { user } = renderApp('/connections', { client });
    await user.type(await screen.findByLabelText('Up personal access token'), 'bad');
    await user.click(screen.getByRole('button', { name: 'Connect Up' }));
    expect(await screen.findByText('Up rejected that token')).toBeInTheDocument();
  });

  it('asks the user to choose accounts after connecting, and sets visibility and category', async () => {
    const client = fakeClient();
    client.up.getUpStatus.mockResolvedValue(status());
    client.up.listUpAccounts.mockResolvedValue([upAccount(), upAccount({ id: 'ua2', displayName: 'Spending' })]);
    client.categories.listCategories.mockResolvedValue([{ id: 'cat-1', name: 'Emergency', color: null, description: null, createdAt: '', updatedAt: '' }]);
    client.up.updateUpAccount.mockResolvedValue(upAccount({ visible: true }));
    const { user } = renderApp('/connections', { client });
    expect(await screen.findByText('Choose the accounts to show')).toBeInTheDocument();
    await user.click(await screen.findByLabelText('Show Emergency fund on the Accounts page'));
    expect(client.up.updateUpAccount).toHaveBeenCalledWith({ accountId: 'ua1', body: { visible: true } });
    await user.selectOptions(screen.getByLabelText('Category for Emergency fund'), 'cat-1');
    expect(client.up.updateUpAccount).toHaveBeenLastCalledWith({ accountId: 'ua1', body: { categoryId: 'cat-1' } });
  });

  it('lets the user press Done with nothing ticked and keeps every account hidden', async () => {
    const client = fakeClient();
    client.up.getUpStatus.mockResolvedValue(status());
    client.up.listUpAccounts.mockResolvedValue([upAccount(), upAccount({ id: 'ua2', displayName: 'Spending' })]);
    const { user } = renderApp('/connections', { client });
    expect(await screen.findByText('Choose the accounts to show')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByLabelText(/Show all accounts/)).toBeInTheDocument();
    expect(screen.queryByText('Choose the accounts to show')).not.toBeInTheDocument();
  });

  it('keeps hidden accounts behind a show-all toggle on the Accounts page', async () => {
    const client = fakeClient();
    client.accounts.listAccounts.mockResolvedValue([]);
    client.up.getUpStatus.mockResolvedValue(status({ accounts: { total: 2, visible: 1, hidden: 1 } }));
    client.up.listUpAccounts.mockImplementation(async ({ visibility }: { visibility: string }) =>
      visibility === 'all' ? [upAccount({ visible: true }), upAccount({ id: 'ua2', displayName: 'Spending' })] : [upAccount({ visible: true })]);
    const { user } = renderApp('/connections', { client });
    expect(await screen.findByText('Shown on your Accounts page')).toBeInTheDocument();
    expect(screen.queryByText('Spending')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText(/Show all accounts/));
    expect(await screen.findByText('Spending')).toBeInTheDocument();
  });

  it('disconnects after confirmation', async () => {
    const client = fakeClient();
    client.up.getUpStatus.mockResolvedValue(status({ accounts: { total: 1, visible: 1, hidden: 0 } }));
    client.up.listUpAccounts.mockResolvedValue([upAccount({ visible: true })]);
    client.up.disconnectUp.mockResolvedValue({ disconnected: true, purged: false, accountsDeleted: 0, transactionsDeleted: 0, webhookRemoved: true });
    const { user } = renderApp('/connections', { client });
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await user.click(screen.getByRole('button', { name: 'Confirm disconnect' }));
    expect(client.up.disconnectUp).toHaveBeenCalledWith({ purge: false });
  });

  it('opens an Up account and lists its imported transactions', async () => {
    const client = fakeClient();
    client.up.listUpAccounts.mockResolvedValue([upAccount({ visible: true })]);
    client.up.listUpTransactions.mockResolvedValue({
      items: [{
        id: 't1', upId: 'ut1', accountId: 'ua1', status: 'SETTLED', description: 'Corner Cafe', message: null, transactionType: null, currency: 'AUD', amount: '-4.50',
        foreignCurrency: null, foreignAmount: null, categoryId: null, transferUpAccountId: null, createdAt: '2026-10-01T01:00:00Z', settledAt: '2026-10-01T02:00:00Z',
        deletedAt: null, matchedTransactionId: null, reconciliation: 'unmatched', source: 'up',
      }],
      nextOffset: null,
    });
    renderApp('/accounts/up/ua1', { client });
    expect(await screen.findByText('Corner Cafe')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Emergency fund' })).toBeInTheDocument();
    expect(client.up.listUpTransactions).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'ua1' }));
  });
});
