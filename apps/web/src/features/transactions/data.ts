import type { RecordTransactionRequest, RecordTransferRequest, Transaction } from '@money/client';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useApi } from '../../app/api';
import { ledgerKeys, queryKeys } from '../shared/queryKeys';

export type TransactionType = Transaction['type'];

export function useTransactions(accountId: string, filter: { type?: TransactionType } = {}) {
  const { run } = useApi();
  return useQuery({
    queryKey: queryKeys.transactions(accountId, filter),
    queryFn: ({ signal }) => run((c) => c.transactions.listTransactions({ accountId, type: filter.type, signal })),
  });
}

export function useTransaction(transactionId: string) {
  const { run } = useApi();
  return useQuery({ queryKey: queryKeys.transaction(transactionId), queryFn: ({ signal }) => run((c) => c.transactions.getTransaction({ transactionId, signal })) });
}

export function useSaleAllocations(transactionId: string | null) {
  const { run } = useApi();
  return useQuery({
    queryKey: queryKeys.allocations(transactionId ?? 'none'),
    queryFn: ({ signal }) => run((c) => c.lots.getSaleAllocations({ transactionId: transactionId!, signal })),
    enabled: Boolean(transactionId),
  });
}

/** Lots available to a sale on `asOf` (open lots only unless includeClosed) */
export function useLots(accountId: string, params: { symbol?: string; asOf?: string; includeClosed?: boolean; excludeTransactionId?: string; enabled?: boolean } = {}) {
  const { run } = useApi();
  const { enabled = true, ...query } = params;
  return useQuery({
    queryKey: queryKeys.lots(accountId, query),
    queryFn: ({ signal }) =>
      run((c) =>
        c.lots.listLots({
          accountId,
          symbol: query.symbol,
          asOf: query.asOf,
          excludeTransactionId: query.excludeTransactionId,
          includeClosed: query.includeClosed ? 'true' : undefined,
          signal,
        }),
      ),
    enabled,
  });
}

export function useTransfers(accountId: string) {
  const { run } = useApi();
  return useQuery({ queryKey: queryKeys.transfers(accountId), queryFn: ({ signal }) => run((c) => c.transfers.listTransfers({ accountId, signal })) });
}

/** After a write, refresh everything derived from the affected ledgers */
export function invalidateLedger(queryClient: QueryClient, accountIds: string[]) {
  for (const id of accountIds) {
    for (const key of ledgerKeys(id)) void queryClient.invalidateQueries({ queryKey: key });
  }
  void queryClient.invalidateQueries({ queryKey: ['transaction'] });
  void queryClient.invalidateQueries({ queryKey: ['allocations'] });
}

export function useRecordTransaction(accountId: string) {
  const { run } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RecordTransactionRequest) => run((c) => c.transactions.recordTransaction({ accountId, body })),
    onSuccess: () => invalidateLedger(queryClient, [accountId]),
  });
}

export function useDeleteTransaction(accountId: string) {
  const { run } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (transactionId: string) => run((c) => c.transactions.deleteTransaction({ transactionId })),
    onSuccess: () => invalidateLedger(queryClient, [accountId]),
  });
}

export function useRecordTransfer() {
  const { run } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RecordTransferRequest) => run((c) => c.transfers.recordTransfer({ body })),
    onSuccess: (transfer) => invalidateLedger(queryClient, [transfer.fromAccountId, transfer.toAccountId]),
  });
}

export function useDeleteTransfer() {
  const { run } = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ transferId }: { transferId: string; accountIds: string[] }) => run((c) => c.transfers.deleteTransfer({ transferId })),
    onSuccess: (_result, { accountIds }) => invalidateLedger(queryClient, accountIds),
  });
}

export const TYPE_LABELS: Record<TransactionType, string> = {
  DEPOSIT: 'Deposit',
  WITHDRAWAL: 'Withdrawal',
  FX_CONVERSION: 'Currency conversion',
  BUY: 'Buy',
  SELL: 'Sell',
  DIVIDEND: 'Dividend',
  TRANSFER_OUT: 'Transfer out',
  TRANSFER_IN: 'Transfer in',
};

export const FIELD_LABELS: Record<string, string> = {
  amount: 'Amount',
  fromAmount: 'Amount converted',
  toAmount: 'Amount received',
  rate: 'Rate',
  quantity: 'Quantity',
  unitPrice: 'Price per share',
  fees: 'Fees',
  total: 'Total',
  grossAmount: 'Gross dividend',
  withholdingTax: 'Tax withheld',
  netAmount: 'Net received',
};
