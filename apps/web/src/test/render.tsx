import { ApiError, type ApiClient } from '@money/client';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { vi, type Mock } from 'vitest';
import { App, createQueryClient } from '../app/App';
import type { SessionInfo, SessionTransport } from '../app/session';

type Fn = Mock<(...args: any[]) => any>;
type Resource = Record<string, Fn>;
export type FakeClient = {
  accounts: Resource;
  transactions: Resource;
  lots: Resource;
  transfers: Resource;
  categories: Resource;
  reports: Resource;
  portfolio: Resource;
  prices: Resource;
  users: Resource;
  valuations: Resource;
};

/** A stand-in for the generated client: every method is a vi.fn with an empty default */
export function fakeClient(): FakeClient {
  const resolve = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    accounts: { listAccounts: resolve([]), getAccount: vi.fn(), createAccount: vi.fn(), updateAccount: vi.fn(), deleteAccount: vi.fn() },
    transactions: { listTransactions: resolve([]), getTransaction: vi.fn(), recordTransaction: vi.fn(), updateTransaction: vi.fn(), deleteTransaction: vi.fn() },
    lots: { listLots: vi.fn(), getSaleAllocations: vi.fn() },
    transfers: { listTransfers: resolve([]), recordTransfer: vi.fn(), getTransfer: vi.fn(), updateTransfer: vi.fn(), deleteTransfer: vi.fn() },
    categories: {
      listCategories: resolve([]),
      listHoldingCategories: resolve([]),
      createCategory: vi.fn(),
      updateCategory: vi.fn(),
      deleteCategory: vi.fn(),
      getCategory: vi.fn(),
      setHoldingCategory: vi.fn(),
      clearHoldingCategory: vi.fn(),
    },
    reports: { getAccountsReport: vi.fn().mockReturnValue(new Promise(() => {})), getCategoriesReport: vi.fn() },
    portfolio: { getAccountPortfolio: vi.fn() },
    prices: { getQuote: vi.fn() },
    users: { getMe: vi.fn() },
    valuations: { getValuationHistory: vi.fn(), getValuationStatus: vi.fn(), requestValuationRecompute: vi.fn() },
  };
}

/** A Money API error as the generated client throws it */
export function apiError(status: number, code: string, message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(new Response(null, { status, statusText: code }), { error: { code, message, ...(details ? { details } : {}) } });
}

export const signedIn: SessionInfo = { authenticated: true, user: { id: 'u1', displayName: 'Ada', email: 'ada@example.com' }, csrfToken: 'csrf-1', expiresAt: '2030-01-01T00:00:00Z' };

export function fakeTransport(session: SessionInfo = signedIn): SessionTransport & { signIn: Fn; logout: Fn; getSession: Fn } {
  return { getSession: vi.fn().mockResolvedValue(session), logout: vi.fn().mockResolvedValue(undefined), signIn: vi.fn() };
}

export function renderApp(route: string, options: { client?: FakeClient; transport?: ReturnType<typeof fakeTransport> } = {}) {
  const client = options.client ?? fakeClient();
  const transport = options.transport ?? fakeTransport();
  const user = userEvent.setup();
  const utils = render(
    <MemoryRouter initialEntries={[route]}>
      <App client={client as unknown as ApiClient} transport={transport} queryClient={createQueryClient()} />
    </MemoryRouter>,
  );
  return { ...utils, client, transport, user };
}
