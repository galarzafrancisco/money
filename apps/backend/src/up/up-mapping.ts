import type { UpAccount, UpTransaction } from './up-api.client';
import type { UpAccountValues, UpTransactionValues } from './up.repository';

export function accountValues(account: UpAccount): UpAccountValues {
  const a = account.attributes;
  return {
    upId: account.id,
    displayName: a.displayName,
    accountType: a.accountType,
    ownershipType: a.ownershipType,
    currency: a.balance.currencyCode,
    balance: a.balance.value,
    upCreatedAt: new Date(a.createdAt),
  };
}

export function transactionValues(transaction: UpTransaction): UpTransactionValues {
  const a = transaction.attributes;
  return {
    upId: transaction.id,
    status: a.status,
    description: a.description,
    rawText: a.rawText ?? null,
    message: a.message ?? null,
    transactionType: a.transactionType ?? null,
    currency: a.amount.currencyCode,
    amount: a.amount.value,
    foreignCurrency: a.foreignAmount?.currencyCode ?? null,
    foreignAmount: a.foreignAmount?.value ?? null,
    categoryId: transaction.relationships?.category?.data?.id ?? null,
    transferUpAccountId: transaction.relationships?.transferAccount?.data?.id ?? null,
    upCreatedAt: new Date(a.createdAt),
    settledAt: a.settledAt ? new Date(a.settledAt) : null,
  };
}
