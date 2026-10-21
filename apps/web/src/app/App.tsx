import type { ApiClient } from '@money/client';
import { moneyErrorOf } from '@money/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiProvider } from './api';
import { AppShell } from './AppShell';
import { ErrorBoundary } from './ErrorBoundary';
import { AppRoutes } from './routes';
import { SessionProvider, type SessionTransport } from './session';
import { SessionGate } from './SignedOut';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Expected API failures (4xx) are shown, not retried; network blips get one retry
        retry: (count, error) => {
          const status = moneyErrorOf(error)?.status;
          return status === undefined ? count < 1 : status >= 500 && count < 1;
        },
        staleTime: 15_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Composition root: session → generated API client → data cache → shell →
 * routes. Tests pass their own session transport and client. The router is
 * supplied by the caller (BrowserRouter in main.tsx, MemoryRouter in tests).
 */
export function App({ transport, client, queryClient }: { transport?: SessionTransport; client?: ApiClient; queryClient?: QueryClient }) {
  const [cache] = useState(() => queryClient ?? createQueryClient());
  return (
    <SessionProvider transport={transport}>
      <SessionGate>
        <ApiProvider client={client}>
          <QueryClientProvider client={cache}>
            <Shell>
              <AppRoutes />
            </Shell>
          </QueryClientProvider>
        </ApiProvider>
      </SessionGate>
    </SessionProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <AppShell>
      <ErrorBoundary>{children}</ErrorBoundary>
    </AppShell>
  );
}
