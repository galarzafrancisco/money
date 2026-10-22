/**
 * React Query keys. Writes invalidate what they change, so balances,
 * holdings and histories refresh after every recorded activity.
 */
export const queryKeys = {
  accounts: ['accounts'] as const,
  account: (id: string) => ['account', id] as const,
  accountsReport: ['reports', 'accounts'] as const,
  dashboard: (settings: object) => ['reports', 'dashboard', settings] as const,
  shareHistory: (currency: string, rates: string) => ['reports', 'share-history', currency, rates] as const,
  portfolio: (id: string) => ['portfolio', id] as const,
  transactions: (accountId: string, filter?: object) => (filter ? (['transactions', accountId, filter] as const) : (['transactions', accountId] as const)),
  transaction: (id: string) => ['transaction', id] as const,
  allocations: (id: string) => ['allocations', id] as const,
  lots: (accountId: string, params?: object) => (params ? (['lots', accountId, params] as const) : (['lots', accountId] as const)),
  transfers: (accountId?: string) => (accountId ? (['transfers', accountId] as const) : (['transfers'] as const)),
  categories: ['categories'] as const,
  holdingCategories: (accountId: string) => ['holding-categories', accountId] as const,
};

/** Everything derived from one account's ledger (and anything aggregating it) */
export function ledgerKeys(accountId: string) {
  return [queryKeys.portfolio(accountId), queryKeys.transactions(accountId), queryKeys.lots(accountId), queryKeys.transfers(), queryKeys.accountsReport, ['reports']];
}
