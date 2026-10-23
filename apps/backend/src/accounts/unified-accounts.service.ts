import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { dec, fmt } from '../common/decimal';
import { NotFoundError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { replayLedger } from '../ledger/ledger-engine';
import { SplitsService } from '../splits/splits.service';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { type TransactionView } from '../transactions/transaction.mapper';
import { TransactionsService } from '../transactions/transactions.service';
import { listTransactionsSchema } from '../transactions/transactions.schemas';
import { UpRepository } from '../up/up.repository';
import { UpService } from '../up/up.service';
import type { CurrentUser } from '../users/users.service';
import { AccountsService, type AccountView } from './accounts.service';

export const listUnifiedAccountsShape = {
  visibility: z.enum(['visible', 'hidden', 'all']).optional().describe('Only affects imported (Up) accounts: visible, hidden or all (default all). Manual accounts are always listed.'),
};

export type UnifiedAccountView = AccountView & {
  /** manual: recorded in Money. up: imported (read-only) from Up and kept in sync automatically */
  source: 'manual' | 'up';
  /** Cash held per currency. Manual accounts: replayed from the ledger. Up: the balance Up last reported */
  balances: { currency: string; amount: string }[];
  /** Imported accounts can be hidden from default views; manual accounts are always true */
  visible: boolean;
};

export type UnifiedTransactionView = Omit<Partial<TransactionView>, 'type'> & {
  id: string;
  accountId: string;
  type: string;
  date: string;
  source: 'manual' | 'up';
};

/**
 * One view of "your accounts" over both kinds: accounts recorded in Money
 * and accounts imported from Up. Callers do not need to know where an
 * account came from; `source` says so for those who care. Storage stays
 * separate (see docs/up-integration.md); this is the read-side seam.
 */
@Injectable()
export class UnifiedAccountsService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly transactions: TransactionsService,
    private readonly transactionRows: TransactionsRepository,
    private readonly upRepo: UpRepository,
    private readonly up: UpService,
    private readonly splits: SplitsService,
  ) {}

  async list(user: CurrentUser, input: unknown = {}): Promise<UnifiedAccountView[]> {
    const { visibility = 'all' } = parseInput(z.object(listUnifiedAccountsShape), input);
    const [manual, upAccounts, rows] = await Promise.all([
      this.accounts.list(user),
      this.upRepo.listAccounts(user.id, null),
      this.transactionRows.list(user.id, {}),
    ]);
    const byAccount = new Map<string, typeof rows>();
    for (const row of rows) byAccount.set(row.accountId, [...(byAccount.get(row.accountId) ?? []), row]);
    const splits = await this.splits.index(rows.filter((r) => r.symbol).map((r) => r.symbol!));
    const out: UnifiedAccountView[] = manual.map((a) => ({
      ...a,
      source: 'manual',
      visible: true,
      balances: cashBalances(replayLedger(this.splits.presentEntriesWith(byAccount.get(a.id) ?? [], splits)).cash),
    }));
    for (const u of upAccounts) {
      if (visibility === 'visible' && !u.visible) continue;
      if (visibility === 'hidden' && u.visible) continue;
      out.push(upToUnified(u));
    }
    return out;
  }

  async get(user: CurrentUser, accountId: string): Promise<UnifiedAccountView> {
    const upAccount = isUuid(accountId) ? await this.upRepo.findAccount(user.id, accountId) : null;
    if (upAccount) return upToUnified(upAccount);
    const manual = await this.accounts.get(user, accountId); // throws NotFoundError
    const rows = await this.transactionRows.list(user.id, { accountId: manual.id });
    return { ...manual, source: 'manual', visible: true, balances: cashBalances(replayLedger(await this.splits.presentEntries(rows)).cash) };
  }

  /** An account's transactions, whichever kind of account it is. Hidden Up accounts work when asked for by ID. */
  async listTransactions(user: CurrentUser, accountId: string, filter: unknown = {}): Promise<UnifiedTransactionView[]> {
    const upAccount = isUuid(accountId) ? await this.upRepo.findAccount(user.id, accountId) : null;
    if (!upAccount) {
      return (await this.transactions.list(user, accountId, filter)).map((t) => ({ ...t, source: 'manual' as const }));
    }
    const parsed = parseInput(listTransactionsSchema, filter);
    // Up transactions are bank cash movements with no instrument, so a symbol filter can match nothing.
    if (parsed.symbol) return [];
    // Page through every Up result so long histories are not truncated.
    const items: Awaited<ReturnType<UpService['listTransactions']>>['items'] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await this.up.listTransactions(user, { accountId, fromDate: parsed.fromDate, toDate: parsed.toDate, limit: 500, offset });
      items.push(...page.items);
      offset = page.nextOffset;
    }
    return items
      .map((t) => {
        const type = dec(t.amount).isNegative() ? 'WITHDRAWAL' : 'DEPOSIT';
        return { ...t, type, date: t.createdAt.slice(0, 10), accountId: upAccount.id, amount: fmt(dec(t.amount).abs()), source: 'up' as const };
      })
      .filter((t) => !parsed.type || t.type === parsed.type);
  }
}

function cashBalances(cash: Map<string, ReturnType<typeof dec>>) {
  return [...cash].filter(([, v]) => !v.isZero()).map(([currency, v]) => ({ currency, amount: fmt(v) }));
}

function upToUnified(u: Awaited<ReturnType<UpRepository['listAccounts']>>[number]): UnifiedAccountView {
  return {
    id: u.id,
    name: u.displayName,
    type: 'CASH',
    reportingCurrency: u.currency,
    description: `Imported from Up (${u.accountType}, ${u.ownershipType})${u.removedAt ? '; no longer listed by Up' : ''}`,
    parentAccountId: null,
    categoryId: u.categoryId,
    createdAt: u.upCreatedAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
    source: 'up',
    visible: u.visible,
    balances: [{ currency: u.currency, amount: fmt(dec(u.balance)) }],
  };
}
