import { screen, within } from '@testing-library/react';
import { account } from '../../test/fixtures';
import { fakeClient, renderApp } from '../../test/render';

const totals = (lines: [string, string][]) => ({ byCurrency: lines.map(([currency, total]) => ({ currency, cash: total, holdings: '0', total })), converted: null });
const member = (kind: 'account' | 'up', id: string, name: string, lines: [string, string][], extra = {}) => ({
  kind, id, name, source: kind === 'up' ? 'up' : 'manual', accountType: 'CASH', counted: true, excludedReason: null, totals: totals(lines), ...extra,
});

function setup() {
  const client = fakeClient();
  const spending = member('up', 'u1', 'Spending', [['AUD', '500']]);
  const savings = member('up', 'u2', 'Savings', [['AUD', '1000']]);
  const hand = member('account', 'a1', 'Cash in hand', [['AUD', '200']]);
  const broker = member('account', 'a2', 'Brokerage', [['AUD', '1000']]);
  const cash = { id: 'g1', name: 'Cash', description: null, createdAt: '', updatedAt: '', members: [spending, savings, hand], totals: totals([['AUD', '1700']]), composition: null };
  client.accountGroups.listAccountGroups.mockResolvedValue({ asOf: '', valuation: 'market', groups: [cash], ungrouped: [broker], totals: totals([['AUD', '2700']]), warnings: [], notes: [] });
  return { client, cash };
}

describe('logical account groups', () => {
  it('shows each group with its physical accounts, provenance and a non-duplicated total', async () => {
    const { client } = setup();
    renderApp('/accounts/groups', { client });
    const card = await screen.findByRole('region', { name: 'Cash accounts' });
    expect(within(card).getByText('Spending')).toBeInTheDocument();
    expect(screen.getAllByText('Up (imported)').length).toBeGreaterThan(0);
    expect(screen.getByText('1,700.00')).toBeInTheDocument(); // group total
    expect(screen.getByText('2,700.00')).toBeInTheDocument(); // everything, counted once
    expect(within(screen.getByRole('region', { name: 'Ungrouped accounts' })).getByText('Brokerage')).toBeInTheDocument();
  });

  it('creates a group, and warns before moving an account out of another group', async () => {
    const { client } = setup();
    client.accountGroups.createAccountGroup.mockResolvedValue({});
    const { user } = renderApp('/accounts/groups', { client });
    await user.click(await screen.findByRole('button', { name: 'New group' }));
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    expect(screen.getByText('Give the group a name.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Group name/), 'Everyday');
    await user.click(screen.getByRole('checkbox', { name: /Brokerage/ }));
    await user.click(screen.getByRole('checkbox', { name: /Spending/ }));
    expect(screen.getByText(/will move out of Cash/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create group' }));
    expect(client.accountGroups.createAccountGroup).toHaveBeenCalledWith({
      body: { name: 'Everyday', description: undefined, members: [{ kind: 'account', id: 'a2' }, { kind: 'up', id: 'u1' }], move: true },
    });
  });

  it('deleting a group releases its accounts after confirmation', async () => {
    const { client } = setup();
    client.accountGroups.deleteAccountGroup.mockResolvedValue({ deleted: true, membersReleased: 3 });
    const { user } = renderApp('/accounts/groups', { client });
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/No account or transaction is deleted/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete group' }));
    expect(client.accountGroups.deleteAccountGroup).toHaveBeenCalledWith({ groupId: 'g1' });
  });

  it('the physical view shows which group each account is in, including imported Up accounts', async () => {
    const { client } = setup();
    client.accounts.listAccounts.mockResolvedValue([account({ id: 'a1', name: 'Cash in hand', type: 'CASH' })]);
    client.up.getUpStatus.mockResolvedValue({ configured: true, status: 'active', webhookStatus: 'none', connectedAt: null, lastSyncAt: null, lastError: null, accounts: { total: 1, visible: 1, hidden: 0 }, hint: null });
    client.up.listUpAccounts.mockResolvedValue([{ id: 'u1', upId: 'x', displayName: 'Spending', accountType: 'TRANSACTIONAL', ownershipType: 'INDIVIDUAL', currency: 'AUD', balance: '500', visible: true, linkedAccountId: null, categoryId: null, source: 'up', lastSyncedAt: null, removedAt: null, upCreatedAt: '' }]);
    renderApp('/accounts', { client });
    await screen.findByText('Spending');
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(within(row).getAllByText('Cash')).toHaveLength(2); // account type badge + group badge
    expect(screen.getByRole('link', { name: 'Logical groups' })).toHaveAttribute('href', '/accounts/groups');
  });
});
