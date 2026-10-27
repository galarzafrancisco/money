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
  dashboard: Resource;
  up: Resource;
  accountGroups: Resource;
  search: Resource;
  tax: Resource;
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
    dashboard: { getDashboard: vi.fn().mockReturnValue(new Promise(() => {})) },
    search: {
      searchMerchants: vi.fn().mockResolvedValue({ items: [], nextOffset: null }),
      searchAccounts: vi.fn().mockResolvedValue({ items: [], nextOffset: null }),
      searchTransactions: vi.fn(),
    },
    accountGroups: {
      listAccountGroups: vi.fn().mockResolvedValue({ asOf: '2025-01-01T00:00:00Z', valuation: 'market', groups: [], ungrouped: [], totals: { byCurrency: [], converted: null }, warnings: [], notes: [] }),
      createAccountGroup: vi.fn(),
      getAccountGroup: vi.fn(),
      updateAccountGroup: vi.fn(),
      deleteAccountGroup: vi.fn(),
    },
    tax: {
      listTaxYears: resolve({ currentTaxYear: '2026-27', years: [], notes: [] }),
      getTaxYear: vi.fn(),
      updateTaxYear: vi.fn(),
      getTaxYearReport: vi.fn(),
      fileTaxYear: vi.fn(),
      reopenTaxYear: vi.fn(),
      getTaxFiling: vi.fn(),
      listTaxItems: resolve({ items: [], notes: [] }),
      createTaxItem: vi.fn(),
      getTaxItem: vi.fn(),
      updateTaxItem: vi.fn(),
      deleteTaxItem: vi.fn(),
      linkTaxTransaction: vi.fn(),
      unlinkTaxTransaction: vi.fn(),
      addTaxEvidence: vi.fn(),
      removeTaxEvidence: vi.fn(),
      listTaxCategories: resolve({ suggested: [{ category: 'self-education', kind: 'DEDUCTION', label: 'Self-education' }], notes: [] }),
      listTaxAssets: resolve({ currentTaxYear: '2026-27', assets: [], notes: [] }),
      registerTaxAsset: vi.fn(),
      getTaxAsset: vi.fn(),
      updateTaxAsset: vi.fn(),
      deleteTaxAsset: vi.fn(),
      getDepreciationSchedule: vi.fn(),
      setTaxAssetYear: vi.fn(),
    },
    up: {
      getUpStatus: resolve({ configured: true, status: 'none', webhookStatus: 'none', connectedAt: null, lastSyncAt: null, lastError: null, accounts: { total: 0, visible: 0, hidden: 0 }, hint: null }),
      listUpAccounts: resolve([]),
      listUpTransactions: resolve({ items: [], nextOffset: null }),
      connectUp: vi.fn(),
      disconnectUp: vi.fn(),
      syncUp: vi.fn(),
      updateUpAccount: vi.fn(),
      setUpAccountVisibility: vi.fn(),
    },
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
