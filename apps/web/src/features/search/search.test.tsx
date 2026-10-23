import { screen, within } from '@testing-library/react';
import { fakeClient, renderApp } from '../../test/render';

const merchant = (over = {}) => ({ merchantKey: 'up:guzman-y-gomez', name: 'Guzman y Gomez', aliases: [], source: 'up', matchType: 'exact', transactionCount: 12, firstTransactionAt: '2022-01-01T00:00:00Z', lastTransactionAt: '2025-01-01T00:00:00Z', ...over });
const item = (over = {}) => ({
  id: 't1', accountId: 'a1', merchant: 'Guzman y Gomez', merchantKey: 'up:guzman-y-gomez', date: '2025-03-04T01:00:00Z', amount: '-18.50', direction: 'out', currency: 'AUD',
  status: 'SETTLED', transfer: false, note: null, source: 'up', type: null, reconciliation: 'unmatched', matchedTransactionId: null, ...over,
});
const page = (items: unknown[], extra = {}) => ({
  items, nextOffset: null, matchedMerchants: null, scope: { accountCount: 1, timezone: 'UTC' },
  summary: { totalCount: items.length, byCurrency: [{ currency: 'AUD', count: items.length, moneyOut: '18.50', moneyIn: '0', net: '-18.50' }] }, ...extra,
});

function setup() {
  const client = fakeClient();
  client.search.searchAccounts.mockResolvedValue({ items: [{ id: 'a1', name: 'Spending', source: 'up', type: 'TRANSACTIONAL', currency: 'AUD', visible: true, parentAccountId: null, removed: false, matchType: 'exact' }], nextOffset: null });
  return client;
}

describe('search', () => {
  it('resolves a merchant, then searches by its key', async () => {
    const client = setup();
    client.search.searchMerchants.mockResolvedValue({ items: [merchant(), merchant({ merchantKey: 'up:guzman-y-gomez-catering', name: 'Guzman y Gomez Catering', matchType: 'prefix' })], nextOffset: null });
    client.search.searchTransactions.mockResolvedValue(page([item()]));
    const { user } = renderApp('/search', { client });
    await user.type(await screen.findByLabelText('Merchant'), 'guzman');
    const list = await screen.findByRole('list', { name: 'Matching merchants' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    await user.click(within(list).getByRole('button', { name: 'Guzman y Gomez' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('1 match')).toBeInTheDocument();
    expect(client.search.searchTransactions).toHaveBeenCalledWith(expect.objectContaining({ merchantKey: 'up:guzman-y-gomez', direction: 'any', offset: 0 }));
    expect(screen.getByRole('region', { name: 'Search results' })).toHaveTextContent('Spending');
  });

  it('requires a currency for amount filters and does not call the server', async () => {
    const client = setup();
    const { user } = renderApp('/search', { client });
    await user.type(await screen.findByLabelText('Min amount'), '50');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText(/Amounts need a currency/)).toBeInTheDocument();
    expect(client.search.searchTransactions).not.toHaveBeenCalled();
  });

  it('shows an empty state and loads more pages', async () => {
    const client = setup();
    client.search.searchTransactions
      .mockResolvedValueOnce(page([item()], { nextOffset: 1, summary: { totalCount: 2, byCurrency: [{ currency: 'AUD', count: 2, moneyOut: '30', moneyIn: '0', net: '-30' }] } }))
      .mockResolvedValueOnce(page([item({ id: 't2', merchant: 'Guzman y Gomez' })], { summary: { totalCount: 2, byCurrency: [] } }));
    const { user } = renderApp('/search?text=burrito&go=1', { client });
    expect(await screen.findByText('2 matches')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Showing 2 of 2')).toBeInTheDocument();
    expect(client.search.searchTransactions).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1, text: 'burrito' }));
  });

  it('says so when nothing matches', async () => {
    const client = setup();
    client.search.searchTransactions.mockResolvedValue(page([], { summary: { totalCount: 0, byCurrency: [] } }));
    renderApp('/search?text=zzz&go=1', { client });
    expect(await screen.findByText('No transactions match')).toBeInTheDocument();
  });
});
