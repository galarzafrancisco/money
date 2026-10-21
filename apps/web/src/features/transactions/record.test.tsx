import { screen, waitFor, within } from '@testing-library/react';
import { account, lot, lotList, saleAllocations, transaction, transfer } from '../../test/fixtures';
import { apiError, fakeClient, renderApp } from '../../test/render';

function withAccount() {
  const client = fakeClient();
  const broker = account();
  client.accounts.getAccount.mockResolvedValue(broker);
  client.accounts.listAccounts.mockResolvedValue([broker, account({ id: 'acc-2', name: 'Bucket', type: 'CASH', parentAccountId: 'acc-1' })]);
  return client;
}

describe('recording activity', () => {
  it('records a buy from three of four figures and shows what Money calculated', async () => {
    const client = withAccount();
    client.transactions.recordTransaction.mockResolvedValue(
      transaction({ id: 'b1', type: 'BUY', symbol: 'VAS.AX', quantity: '10', unitPrice: '90.5', fees: '5', total: '910', calculatedField: 'total', amount: undefined }),
    );
    const { user } = renderApp('/accounts/acc-1/record?type=BUY', { client });

    expect(await screen.findByText(/You are recording something that already happened/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Trade date'));
    await user.type(screen.getByLabelText('Trade date'), '2024-01-04');
    await user.type(screen.getByLabelText('Symbol'), 'vas.ax');
    await user.type(screen.getByLabelText('Quantity'), '10');
    await user.type(screen.getByLabelText(/Price per share/), '90.5');
    expect(screen.getByText(/Enter any 3 of the 4 figures/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Fees/), '5');
    expect(screen.getByText('Money will calculate total from the others.')).toBeInTheDocument();
    expect(screen.getByText('Money calculates this')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Record buy' }));
    expect(client.transactions.recordTransaction).toHaveBeenCalledWith({
      accountId: 'acc-1',
      body: { type: 'BUY', date: '2024-01-04', symbol: 'VAS.AX', currency: 'AUD', quantity: '10', unitPrice: '90.5', fees: '5' },
    });
    expect(await screen.findByText('Recorded')).toBeInTheDocument();
    expect(screen.getByText('calculated')).toBeInTheDocument();
    expect(screen.getByText('910.00')).toBeInTheDocument();
  });

  it('refuses a trade with fewer than three figures before calling the API', async () => {
    const client = withAccount();
    const { user } = renderApp('/accounts/acc-1/record?type=BUY', { client });
    await user.type(await screen.findByLabelText('Symbol'), 'VOO');
    await user.type(screen.getByLabelText('Quantity'), '1');
    await user.click(screen.getByRole('button', { name: 'Record buy' }));
    expect(screen.getByText('Enter at least three of quantity, price, fees and total.')).toBeInTheDocument();
    expect(client.transactions.recordTransaction).not.toHaveBeenCalled();
  });

  it('sells from chosen lots: 40 split 15 + 25 across two lots', async () => {
    const client = withAccount();
    client.lots.listLots.mockResolvedValue(
      lotList([lot({ lotId: 'lot-1', remainingQuantity: '100' }), lot({ lotId: 'lot-2', acquiredOn: '2023-06-01', sequence: 3, remainingQuantity: '200', unitCostBase: '95', heldOverTwelveMonths: false, daysHeld: 274 })]),
    );
    client.transactions.recordTransaction.mockResolvedValue(transaction({ id: 'sale-1', type: 'SELL', symbol: 'VAS.AX', quantity: '40', unitPrice: '100', fees: '10', total: '3990', calculatedField: 'total', lotSelection: 'SPECIFIC', amount: undefined }));
    client.lots.getSaleAllocations.mockResolvedValue(saleAllocations());
    const { user } = renderApp('/accounts/acc-1/record?type=SELL', { client });

    await user.clear(await screen.findByLabelText('Trade date'));
    await user.type(screen.getByLabelText('Trade date'), '2024-03-01');
    await user.type(screen.getByLabelText('Symbol'), 'VAS.AX');
    await user.type(screen.getByLabelText('Quantity'), '40');
    await user.type(screen.getByLabelText(/Price per share/), '100');
    await user.type(screen.getByLabelText(/^Fees/), '10');
    await user.click(screen.getByLabelText('Choose lots'));

    const picker = await screen.findByRole('region', { name: 'Lots to sell from' });
    await waitFor(() => expect(client.lots.listLots).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc-1', symbol: 'VAS.AX', asOf: '2024-03-01' })));
    const [first, second] = within(picker).getAllByRole('textbox');
    await user.type(first, '15');
    expect(screen.getByText('Chosen 15 of 40 shares')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record sale' }));
    expect(screen.getByText('The shares chosen from lots must add up to the quantity sold.')).toBeInTheDocument();
    expect(client.transactions.recordTransaction).not.toHaveBeenCalled();

    await user.type(second, '25');
    expect(screen.getByText('Chosen 40 of 40 shares ✓')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record sale' }));
    expect(client.transactions.recordTransaction).toHaveBeenCalledWith({
      accountId: 'acc-1',
      body: expect.objectContaining({
        type: 'SELL',
        quantity: '40',
        allocations: [
          { lotId: 'lot-1', quantity: '15' },
          { lotId: 'lot-2', quantity: '25' },
        ],
      }),
    });
    const allocations = await screen.findByRole('region', { name: 'Sale allocations' });
    expect(within(allocations).getAllByRole('row')).toHaveLength(4);
  });

  it('flags a lot over-allocation and re-fetches lots after a ledger violation', async () => {
    const client = withAccount();
    client.lots.listLots.mockResolvedValue(lotList([lot({ lotId: 'lot-1', remainingQuantity: '5' })]));
    client.transactions.recordTransaction.mockRejectedValue(apiError(422, 'ledger_violation', 'lot lot-1 has only 5 shares left on that date'));
    const { user } = renderApp('/accounts/acc-1/record?type=SELL', { client });
    await user.type(await screen.findByLabelText('Symbol'), 'VAS.AX');
    await user.type(screen.getByLabelText('Quantity'), '5');
    await user.type(screen.getByLabelText(/Price per share/), '100');
    await user.type(screen.getByLabelText(/^Fees/), '0');
    await user.click(screen.getByLabelText('Choose lots'));
    const input = within(await screen.findByRole('region', { name: 'Lots to sell from' })).getByRole('textbox');
    await user.type(input, '6');
    expect(screen.getByText('More than this lot has left.')).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '5');
    const callsBefore = client.lots.listLots.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Record sale' }));
    expect(await screen.findByText('lot lot-1 has only 5 shares left on that date')).toBeInTheDocument();
    expect(screen.getByText('The account history does not allow this')).toBeInTheDocument();
    await waitFor(() => expect(client.lots.listLots.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('records a dividend from two of three figures', async () => {
    const client = withAccount();
    client.transactions.recordTransaction.mockResolvedValue(transaction({ type: 'DIVIDEND', symbol: 'VOO', currency: 'USD', grossAmount: '100', withholdingTax: '15', netAmount: '85', frankingCredits: '0', calculatedField: 'netAmount', amount: undefined }));
    const { user } = renderApp('/accounts/acc-1/record?type=DIVIDEND', { client });
    await user.type(await screen.findByLabelText('Symbol'), 'VOO');
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'USD');
    await user.type(screen.getByLabelText('Gross dividend'), '100');
    await user.type(screen.getByLabelText('Tax withheld'), '15');
    await user.click(screen.getByRole('button', { name: 'Record dividend' }));
    expect(client.transactions.recordTransaction).toHaveBeenCalledWith({
      accountId: 'acc-1',
      body: expect.objectContaining({ type: 'DIVIDEND', symbol: 'VOO', currency: 'USD', grossAmount: '100', withholdingTax: '15' }),
    });
    expect(await screen.findByText(/Net received/)).toBeInTheDocument();
  });

  it('records a deposit and shows the backend validation message on failure', async () => {
    const client = withAccount();
    client.transactions.recordTransaction.mockRejectedValueOnce(apiError(400, 'validation_failed', 'Invalid input: amount: must be greater than zero'));
    const { user } = renderApp('/accounts/acc-1/record', { client });
    await user.type(await screen.findByLabelText('Amount'), '0');
    await user.click(screen.getByRole('button', { name: 'Record deposit' }));
    expect(await screen.findByText('Invalid input: amount: must be greater than zero')).toBeInTheDocument();
    expect(screen.getByText('Check the details')).toBeInTheDocument();
  });

  it('records an FX conversion from an amount and a rate', async () => {
    const client = withAccount();
    client.transactions.recordTransaction.mockResolvedValue(transaction({ type: 'FX_CONVERSION', fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: '1000', toAmount: '650', rate: '0.65', fees: '0', calculatedField: 'toAmount', amount: undefined, currency: undefined }));
    const { user } = renderApp('/accounts/acc-1/record?type=FX_CONVERSION', { client });
    await user.type(await screen.findByLabelText('To currency'), 'usd');
    await user.type(screen.getByLabelText(/Amount converted/), '1000');
    await user.type(screen.getByLabelText(/^Rate/), '0.65');
    await user.click(screen.getByRole('button', { name: 'Record conversion' }));
    expect(client.transactions.recordTransaction).toHaveBeenCalledWith({
      accountId: 'acc-1',
      body: expect.objectContaining({ type: 'FX_CONVERSION', fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: '1000', rate: '0.65' }),
    });
    expect(await screen.findByText('Recorded')).toBeInTheDocument();
    expect(screen.getByText(/Amount received:/)).toHaveTextContent('650.00');
  });

  it('records a transfer into a subaccount', async () => {
    const client = withAccount();
    client.transfers.recordTransfer.mockResolvedValue(transfer());
    const { user } = renderApp('/accounts/acc-1/record?type=TRANSFER', { client });
    await user.selectOptions(await screen.findByLabelText('To account'), 'acc-2');
    await user.type(screen.getByLabelText(/Amount sent/), '100');
    await user.click(screen.getByRole('button', { name: 'Record transfer' }));
    expect(client.transfers.recordTransfer).toHaveBeenCalledWith({
      body: expect.objectContaining({ fromAccountId: 'acc-1', toAccountId: 'acc-2', fromCurrency: 'AUD', toCurrency: 'AUD', fromAmount: '100' }),
    });
    expect(await screen.findByText('Recorded')).toBeInTheDocument();
  });
});
