import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { NotFoundError, ValidationError } from '../common/errors';
import { parseInput } from '../common/validation';
import { AccountsRepository } from '../accounts/accounts.repository';
import { isUuid } from '../accounts/accounts.service';
import { UnitOfWork } from '../database/unit-of-work';
import { replayLedger } from '../ledger/ledger-engine';
import type { TransactionType } from '../ledger/ledger.types';
import type { CurrentUser } from '../users/users.service';
import { TransactionEntity } from './transaction.entity';
import { TransactionsRepository } from './transactions.repository';
import { materialize, storedInputFields, toLedgerEntry, toTransactionView, type TransactionFields, type TransactionView } from './transaction.mapper';
import {
  UPDATABLE_FIELDS,
  depositSchema,
  dividendSchema,
  fxSchema,
  listTransactionsSchema,
  recordTransactionSchema,
  tradeSchema,
  updateTransactionSchema,
  withdrawalSchema,
  type RecordTransactionInput,
  type UpdateTransactionInput,
} from './transactions.schemas';

const SCHEMA_BY_TYPE = {
  DEPOSIT: depositSchema,
  WITHDRAWAL: withdrawalSchema,
  FX_CONVERSION: fxSchema,
  BUY: tradeSchema,
  SELL: tradeSchema,
  DIVIDEND: dividendSchema,
} as const;

/**
 * Records, edits and deletes account activity. These are records of what
 * happened elsewhere (entered by hand or by external automation): nothing
 * here moves money or places trades.
 *
 * Every change runs in one database transaction that locks the account row,
 * re-reads all of the account's transactions, applies the change in memory
 * and replays the whole ledger. If the replay finds a violation (negative
 * cash, overselling, a ticker in two currencies) nothing is written.
 */
@Injectable()
export class TransactionsService {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly accounts: AccountsRepository,
    private readonly uow: UnitOfWork,
  ) {}

  /** REST entry point: the body names the type */
  record(user: CurrentUser, accountId: string, input: RecordTransactionInput): Promise<TransactionView> {
    const { type, ...rest } = parseInput(recordTransactionSchema, input);
    return this.create(user, accountId, type, rest as TransactionFields);
  }

  /** MCP entry point: the tool names the type */
  recordOfType(user: CurrentUser, accountId: string, type: TransactionType, input: unknown): Promise<TransactionView> {
    const fields = parseInput(SCHEMA_BY_TYPE[type], input) as TransactionFields;
    return this.create(user, accountId, type, fields);
  }

  async list(user: CurrentUser, accountId: string, filter: unknown = {}): Promise<TransactionView[]> {
    const parsed = parseInput(listTransactionsSchema, filter);
    await this.requireAccount(user, accountId);
    const rows = await this.transactions.list(user.id, { accountId, ...parsed });
    return rows.map(toTransactionView);
  }

  async get(user: CurrentUser, transactionId: string): Promise<TransactionView> {
    const row = isUuid(transactionId) ? await this.transactions.find(user.id, transactionId) : null;
    if (!row) throw new NotFoundError(`Transaction ${transactionId} not found`);
    return toTransactionView(row);
  }

  /**
   * Edits a transaction. The type and account cannot change (delete and
   * re-record instead). Fields not given keep their values; the field Money
   * calculated last time is recalculated unless it is given; a calculable
   * field set to null is recalculated.
   */
  async update(user: CurrentUser, transactionId: string, input: UpdateTransactionInput): Promise<TransactionView> {
    const patch = parseInput(updateTransactionSchema, input) as TransactionFields;
    return this.uow.run(async (manager) => {
      const existing = await this.lockTransactionAccount(user, transactionId, manager);
      const allowed = UPDATABLE_FIELDS[existing.type];
      const notAllowed = Object.keys(patch).filter((key) => patch[key as keyof TransactionFields] !== undefined && !allowed.includes(key));
      if (notAllowed.length > 0) {
        throw new ValidationError(`${notAllowed.join(', ')} cannot be set on a ${existing.type} transaction`, {
          allowed,
        });
      }
      const fields: TransactionFields = { ...storedInputFields(existing) };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) fields[key as keyof TransactionFields] = value;
      }
      const updated = Object.assign(new TransactionEntity(), existing, materialize(existing.type, fields));
      await this.validateLedger(user, existing.accountId, manager, (rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      return toTransactionView(await this.transactions.save(updated, manager));
    });
  }

  /** Deletes a transaction, unless the remaining ledger would be inconsistent (e.g. deleting a deposit that later buys depend on) */
  async delete(user: CurrentUser, transactionId: string): Promise<{ deleted: true }> {
    return this.uow.run(async (manager) => {
      const existing = await this.lockTransactionAccount(user, transactionId, manager);
      await this.validateLedger(user, existing.accountId, manager, (rows) => rows.filter((row) => row.id !== existing.id));
      await this.transactions.delete(user.id, existing.id, manager);
      return { deleted: true as const };
    });
  }

  private async create(user: CurrentUser, accountId: string, type: TransactionType, fields: TransactionFields): Promise<TransactionView> {
    const columns = materialize(type, fields);
    return this.uow.run(async (manager) => {
      const account = isUuid(accountId) ? await this.accounts.findForUpdate(user.id, accountId, manager) : null;
      if (!account) throw new NotFoundError(`Account ${accountId} not found`);
      const entity = Object.assign(new TransactionEntity(), {
        id: randomUUID(),
        userId: user.id,
        accountId: account.id,
        type,
        sequence: await this.transactions.nextSequence(account.id, manager),
        ...columns,
      });
      await this.validateLedger(user, account.id, manager, (rows) => [...rows, entity]);
      return toTransactionView(await this.transactions.save(entity, manager));
    });
  }

  private async requireAccount(user: CurrentUser, accountId: string): Promise<void> {
    const account = isUuid(accountId) ? await this.accounts.find(user.id, accountId) : null;
    if (!account) throw new NotFoundError(`Account ${accountId} not found`);
  }

  /** Finds the user's transaction and locks its account; NotFound for anyone else's */
  private async lockTransactionAccount(user: CurrentUser, transactionId: string, manager: EntityManager): Promise<TransactionEntity> {
    const found = isUuid(transactionId) ? await this.transactions.find(user.id, transactionId, manager) : null;
    if (!found) throw new NotFoundError(`Transaction ${transactionId} not found`);
    await this.accounts.findForUpdate(user.id, found.accountId, manager);
    // Re-read under the lock, in case it changed while we waited
    const current = await this.transactions.find(user.id, transactionId, manager);
    if (!current) throw new NotFoundError(`Transaction ${transactionId} not found`);
    return current;
  }

  private async validateLedger(
    user: CurrentUser,
    accountId: string,
    manager: EntityManager,
    change: (rows: TransactionEntity[]) => TransactionEntity[],
  ): Promise<void> {
    const rows = await this.transactions.listForAccount(user.id, accountId, manager);
    replayLedger(change(rows).map(toLedgerEntry));
  }
}
