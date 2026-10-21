import { screen, waitFor } from '@testing-library/react';
import { account } from '../test/fixtures';
import { apiError, fakeClient, fakeTransport, renderApp } from '../test/render';

describe('session', () => {
  it('offers Taico sign-in when signed out, with no local login form', async () => {
    const transport = fakeTransport({ authenticated: false, loginUrl: '/auth/login' });
    const { user } = renderApp('/accounts', { transport });
    const button = await screen.findByRole('button', { name: 'Sign in with Taico' });
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    await user.click(button);
    expect(transport.signIn).toHaveBeenCalledWith('/');
  });

  it('shows a sign-in error passed back as ?authError and strips it from the URL', async () => {
    window.history.replaceState(null, '', '/accounts?authError=access_denied');
    renderApp('/accounts', { transport: fakeTransport({ authenticated: false }) });
    expect(await screen.findByText('Sign-in was cancelled in Taico.')).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('ends the session when the API answers 401', async () => {
    const client = fakeClient();
    client.accounts.listAccounts.mockRejectedValue(apiError(401, 'session_expired', 'Session expired'));
    renderApp('/accounts', { client });
    expect(await screen.findByText('Your session ended')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with Taico' })).toBeInTheDocument();
  });

  it('signs out locally through the session module', async () => {
    const client = fakeClient();
    client.accounts.listAccounts.mockResolvedValue([account()]);
    const transport = fakeTransport();
    const { user } = renderApp('/accounts', { client, transport });
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(transport.logout).toHaveBeenCalledWith('csrf-1'));
    expect(await screen.findByText('You are signed out of Money.')).toBeInTheDocument();
  });
});
