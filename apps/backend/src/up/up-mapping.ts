import { UpUnavailableError, type UpAccount, type UpTransaction } from './up-api.client';
import type { UpAccountValues, UpTransactionValues } from './up.repository';

/**
 * Up documents plain decimal strings ("-10.00"), but foreign amounts arrive in
 * the foreign currency's own format ("-1000,00" for ARS). The last separator is
 * taken as the decimal point when 1-2 digits follow it, otherwise as a grouping
 * mark. Anything that is still not a decimal is rejected without echoing it.
 */
export function normalizeDecimal(value: string): string {
  const v = value.trim().replace(/\s/g, '');
  const m = /^([+-]?)(\d[\d.,]*)$/.exec(v);
  if (!m) throw new UpUnavailableError('Up returned an unreadable amount');
  const body = m[2];
  const last = Math.max(body.lastIndexOf('.'), body.lastIndexOf(','));
  const decimals = last >= 0 && body.length - last - 1 <= 2;
  const digits = (decimals ? body.slice(0, last) : body).replace(/[.,]/g, '');
  const result = `${m[1] === '-' ? '-' : ''}${digits}${decimals ? `.${body.slice(last + 1)}` : ''}`;
  if (!/^-?\d+(\.\d+)?$/.test(result)) throw new UpUnavailableError('Up returned an unreadable amount');
  return result;
}

export function accountValues(account: UpAccount): UpAccountValues {
  const a = account.attributes;
  return {
    upId: account.id,
    displayName: a.displayName,
    accountType: a.accountType,
    ownershipType: a.ownershipType,
    currency: a.balance.currencyCode,
    balance: normalizeDecimal(a.balance.value),
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
    amount: normalizeDecimal(a.amount.value),
    foreignCurrency: a.foreignAmount?.currencyCode ?? null,
    foreignAmount: a.foreignAmount ? normalizeDecimal(a.foreignAmount.value) : null,
    categoryId: transaction.relationships?.category?.data?.id ?? null,
    transferUpAccountId: transaction.relationships?.transferAccount?.data?.id ?? null,
    upCreatedAt: new Date(a.createdAt),
    settledAt: a.settledAt ? new Date(a.settledAt) : null,
  };
}
