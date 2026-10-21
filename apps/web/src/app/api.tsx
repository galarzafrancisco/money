import { ApiClient, moneyErrorOf } from '@money/client';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useSession } from './session';

/**
 * Hands feature data modules a per-session generated client
 * (docs/architecture/api-clients.md). The web app authenticates with the
 * backend's cookie session: no getAccessToken, `credentials: same-origin`,
 * and the session's CSRF token on every request.
 */
export type MoneyApi = {
  client: ApiClient;
  /**
   * Runs a call with the current client. A 401 ends the session (the shell
   * then offers sign-in); a stale CSRF token is refreshed and the call retried
   * once, as docs/web-auth.md asks.
   */
  run: <T>(call: (client: ApiClient) => Promise<T>) => Promise<T>;
};

const ApiContext = createContext<MoneyApi | null>(null);

export function createSessionClient(csrfToken: string): ApiClient {
  return new ApiClient({
    baseUrl: window.location.origin,
    credentials: 'same-origin',
    headers: { 'X-CSRF-Token': csrfToken },
  });
}

export function ApiProvider({ client: override, children }: { client?: ApiClient; children: ReactNode }) {
  const session = useSession();
  const csrfToken = session.state.status === 'signedIn' ? session.state.csrfToken : null;
  const client = useMemo(() => override ?? (csrfToken ? createSessionClient(csrfToken) : null), [override, csrfToken]);
  const { markExpired, refresh } = session;

  const run = useCallback(
    async <T,>(call: (client: ApiClient) => Promise<T>): Promise<T> => {
      if (!client) throw new Error('Not signed in');
      try {
        return await call(client);
      } catch (error) {
        const failure = moneyErrorOf(error);
        if (failure?.status === 401) {
          markExpired();
        } else if (failure?.code === 'csrf_failed' && !override) {
          const fresh = await refresh();
          if (fresh) return call(createSessionClient(fresh));
        }
        throw error;
      }
    },
    [client, markExpired, refresh, override],
  );

  const value = useMemo(() => (client ? { client, run } : null), [client, run]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): MoneyApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi outside a signed-in ApiProvider');
  return api;
}
