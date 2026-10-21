import { screen } from '@testing-library/react';
import { category } from '../../test/fixtures';
import { apiError, fakeClient, renderApp } from '../../test/render';

describe('categories', () => {
  it('creates a category after validating the colour', async () => {
    const client = fakeClient();
    client.categories.createCategory.mockResolvedValue(category({ id: 'c2', name: 'Speculative' }));
    const { user } = renderApp('/categories', { client });
    await user.type(await screen.findByLabelText('Name'), 'Speculative');
    await user.type(screen.getByLabelText('Colour'), 'red');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    expect(screen.getByText('Use a #rrggbb colour, e.g. #4f9d69.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Colour'));
    await user.type(screen.getByLabelText('Colour'), '#aa3300');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    expect(client.categories.createCategory).toHaveBeenCalledWith({ body: { name: 'Speculative', color: '#aa3300' } });
  });

  it('asks before unassigning a category that is in use, then deletes it', async () => {
    const client = fakeClient();
    client.categories.listCategories.mockResolvedValue([category()]);
    client.categories.deleteCategory
      .mockRejectedValueOnce(apiError(409, 'conflict', 'Category "Core" is assigned', { accounts: 2, holdings: 1 }))
      .mockResolvedValueOnce({ deleted: true, unassigned: { accounts: 2, holdings: 1 } });
    const { user } = renderApp('/categories', { client });
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(await screen.findByText(/Used by 2 account\(s\) and 1 holding\(s\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unassign and delete' }));
    expect(client.categories.deleteCategory).toHaveBeenLastCalledWith({ categoryId: 'cat-1', unassign: 'true' });
  });
});
