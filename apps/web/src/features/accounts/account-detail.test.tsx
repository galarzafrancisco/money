import { screen, within } from '@testing-library/react';
import { account, category, lot, lotList, portfolio, saleAllocations, transaction } from '../../test/fixtures';
import { apiError, fakeClient, renderApp } from '../../test/render';

function withAccount() {
  const client = fakeClient();
  const broker = account();
  client.accounts.getAccount.mockResolvedValue(broker);
  client.accounts.listAccounts.mockResolvedValue([broker, account({ id: 'acc-2', name: 'Bucket', type: 'CASH', parentAccountId: 'acc-1' })]);
  client.portfolio.getAccountPortfolio.mockResolvedValue(portfolio(broker));
  client.categories.listCategories.mockResolvedValue([category()]);
  return client;
}

describe('account detail', () => {
  it('shows cash, holdings with labelled mock prices, and in-app sections', async () => {
    const client = withAccount();
    renderApp('/accounts/acc-1', { client });
    expect(await screen.findByRole('heading', { name: 'Broker' })).toBeInTheDocument();
    const holdings = await screen.findByRole('region', { name: 'Holdings' });
    expect(within(holdings).getByText('VAS.AX')).toBeInTheDocument();
    expect(within(holdings).getByText('Mock price')).toBeInTheDocument();
    expect(within(holdings).getByText('30K')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Cash balances' })).getByText('1,234.50')).toBeInTheDocument();
    const sections = screen.getByRole('navigation', { name: 'Account sections' });
    expect(within(sections).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  it('navigates to transactions and into a sale with its lot allocations', async () => {
    const client = withAccount();
    const sale = transaction({ id: 'sale-1', type: 'SELL', date: '2024-03-01', symbol: 'VAS.AX', quantity: '40', unitPrice: '100', fees: '10', total: '3990', calculatedField: 'total', lotSelection: 'SPECIFIC', amount: undefined });
    client.transactions.listTransactions.mockResolvedValue([transaction(), sale]);
    client.transactions.getTransaction.mockResolvedValue(sale);
    client.lots.getSaleAllocations.mockResolvedValue(saleAllocations());
    const { user } = renderApp('/accounts/acc-1', { client });

    await user.click(await screen.findByRole('link', { name: 'Transactions' }));
    const table = await screen.findByRole('region', { name: 'Transactions' });
    expect(within(table).getByText('Chosen lots')).toBeInTheDocument();
    await user.click(within(table).getByRole('link', { name: '2024-03-01' }));

    expect(await screen.findByText('Sell on 2024-03-01')).toBeInTheDocument();
    expect(screen.getByText('calculated')).toBeInTheDocument();
    const allocations = await screen.findByRole('region', { name: 'Sale allocations' });
    expect(within(allocations).getByText('> 12 months')).toBeInTheDocument();
    expect(within(allocations).getByText('265.00', { exact: false })).toBeInTheDocument();
    expect(client.lots.getSaleAllocations).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 'sale-1' }));
  });

  it('links to the sales that block deleting a purchase', async () => {
    const client = withAccount();
    const buy = transaction({ id: 'buy-1', type: 'BUY', symbol: 'VAS.AX', quantity: '100', unitPrice: '90', fees: '0', total: '9000' });
    client.transactions.getTransaction.mockResolvedValue(buy);
    client.transactions.deleteTransaction.mockRejectedValue(apiError(409, 'conflict', 'Sales allocate from this purchase', { saleTransactionIds: ['sale-9'] }));
    const { user } = renderApp('/accounts/acc-1/transactions/buy-1', { client });
    await user.click(await screen.findByRole('button', { name: 'Delete record' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Sales allocate from this purchase')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sale using this purchase' })).toHaveAttribute('href', '/accounts/acc-1/transactions/sale-9');
  });

  it('shows not found for another user\'s account', async () => {
    const client = fakeClient();
    client.accounts.getAccount.mockRejectedValue(apiError(404, 'not_found', 'Account x not found'));
    renderApp('/accounts/x', { client });
    expect(await screen.findByText('Account not found')).toBeInTheDocument();
  });

  it('assigns a category to a holding', async () => {
    const client = withAccount();
    client.categories.setHoldingCategory.mockResolvedValue({ accountId: 'acc-1', symbol: 'VAS.AX', categoryId: 'cat-1' });
    const { user } = renderApp('/accounts/acc-1', { client });
    await user.selectOptions(await screen.findByLabelText('Category for VAS.AX'), 'cat-1');
    expect(client.categories.setHoldingCategory).toHaveBeenCalledWith({ accountId: 'acc-1', symbol: 'VAS.AX', body: { categoryId: 'cat-1' } });
  });

  it('lists open lots', async () => {
    const client = withAccount();
    client.lots.listLots.mockResolvedValue(lotList([lot()]));
    renderApp('/accounts/acc-1/lots', { client });
    const lots = await screen.findByRole('region', { name: 'Lots' });
    expect(within(lots).getByText('Open')).toBeInTheDocument();
    expect(within(lots).getByText('> 12 months')).toBeInTheDocument();
  });
});
