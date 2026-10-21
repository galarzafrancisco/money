import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * The app-level session module (docs/web-auth.md "Contract for the web app").
 * It is the only code that talks to /auth/*: those endpoints belong to the
 * browser sign-in flow, not the REST resource, so they are deliberately not in
 * the generated client. Feature code never sees tokens; the browser holds
 * only the backend's HttpOnly cookie, and this module hands the CSRF token to
 * the API client.
 */
export type SessionUser = { id: string; displayName: string | null; email: string | null };

export type SessionInfo =
  | { authenticated: false; loginUrl?: string }
  | { authenticated: true; user: SessionUser; csrfToken: string; expiresAt: string };

/** How the session module reaches the backend; replaced in tests */
export type SessionTransport = {
  getSession: () => Promise<SessionInfo>;
  logout: (csrfToken: string) => Promise<void>;
  /** Full-page navigation to sign in */
  signIn: (returnTo: string) => void;
};

export const browserSessionTransport: SessionTransport = {
  async getSession() {
    const response = await fetch('/auth/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Could not check your session (HTTP ${response.status})`);
    return (await response.json()) as SessionInfo;
  },
  async logout(csrfToken) {
    const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } });
    if (!response.ok && response.status !== 401) throw new Error(`Sign-out failed (HTTP ${response.status})`);
  },
  signIn(returnTo) {
    window.location.assign(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  },
};

export type SignedOutReason = 'expired' | 'signed_out' | null;

export type SessionState =
  | { status: 'loading' }
  | { status: 'signedOut'; reason: SignedOutReason; authError: string | null }
  | { status: 'signedIn'; user: SessionUser; csrfToken: string; expiresAt: string }
  | { status: 'error'; message: string };

type SessionApi = {
  state: SessionState;
  signIn: () => void;
  signOut: () => Promise<void>;
  /** Re-reads the session (e.g. after a stale CSRF token); resolves to the new CSRF token, or null when signed out */
  refresh: () => Promise<string | null>;
  /** Called when the API answers 401: the session ended */
  markExpired: () => void;
};

const SessionContext = createContext<SessionApi | null>(null);

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'Sign-in was cancelled in Taico.',
  login_expired: 'The sign-in attempt expired. Please try again.',
  invalid_request: 'The sign-in response was not valid. Please try again.',
  sign_in_failed: 'Taico could not sign you in. Please try again.',
  auth_unavailable: 'Taico is unreachable right now. Please try again shortly.',
};

export function authErrorMessage(code: string | null): string | null {
  if (!code) return null;
  return AUTH_ERROR_MESSAGES[code] ?? 'Sign-in failed. Please try again.';
}

/** Reads and strips ?authError= from the URL (the backend adds it after a failed sign-in) */
function takeAuthError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('authError');
  if (code) {
    url.searchParams.delete('authError');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }
  return code;
}

function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function SessionProvider({ transport = browserSessionTransport, children }: { transport?: SessionTransport; children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  const load = useCallback(
    async (authError: string | null = null): Promise<string | null> => {
      try {
        const info = await transport.getSession();
        if (info.authenticated) {
          setState({ status: 'signedIn', user: info.user, csrfToken: info.csrfToken, expiresAt: info.expiresAt });
          return info.csrfToken;
        }
        setState((previous) => ({
          status: 'signedOut',
          reason: previous.status === 'signedOut' ? previous.reason : null,
          authError,
        }));
        return null;
      } catch (error) {
        setState({ status: 'error', message: error instanceof Error ? error.message : 'Could not reach Money.' });
        return null;
      }
    },
    [transport],
  );

  useEffect(() => {
    void load(takeAuthError());
  }, [load]);

  const api = useMemo<SessionApi>(
    () => ({
      state,
      signIn: () => transport.signIn(currentPath()),
      signOut: async () => {
        if (state.status === 'signedIn') await transport.logout(state.csrfToken);
        setState({ status: 'signedOut', reason: 'signed_out', authError: null });
      },
      refresh: () => load(),
      markExpired: () => setState({ status: 'signedOut', reason: 'expired', authError: null }),
    }),
    [state, transport, load],
  );

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}
