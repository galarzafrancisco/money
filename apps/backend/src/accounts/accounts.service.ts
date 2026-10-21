import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../common/errors';
import { parseInput } from '../common/validation';
import { UnitOfWork } from '../database/unit-of-work';
import { TransactionsRepository } from '../transactions/transactions.repository';
import type { CurrentUser } from '../users/users.service';
import { AccountEntity } from './account.entity';
import { AccountsRepository } from './accounts.repository';
import {
  createAccountSchema,
  deleteAccountSchema,
  updateAccountSchema,
  type CreateAccountInput,
  type UpdateAccountInput,
} from './accounts.schemas';

export type AccountView = {
  id: string;
  name: string;
  type: AccountEntity['type'];
  reportingCurrency: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class AccountsService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly transactions: TransactionsRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async list(user: CurrentUser): Promise<AccountView[]> {
    return (await this.accounts.list(user.id)).map(toView);
  }

  async get(user: CurrentUser, accountId: string): Promise<AccountView> {
    return toView(await this.require(user, accountId));
  }

  /** The account entity, or NotFoundError when it does not exist or belongs to someone else */
  async require(user: CurrentUser, accountId: string): Promise<AccountEntity> {
    const account = isUuid(accountId) ? await this.accounts.find(user.id, accountId) : null;
    if (!account) throw new NotFoundError(`Account ${accountId} not found`);
    return account;
  }

  async create(user: CurrentUser, input: CreateAccountInput): Promise<AccountView> {
    const data = parseInput(createAccountSchema, input);
    return this.uow.run(async (manager) => {
      if (await this.accounts.nameTaken(user.id, data.name, null, manager)) {
        throw new ConflictError(`You already have an account named "${data.name}"`);
      }
      const account = Object.assign(new AccountEntity(), {
        id: randomUUID(),
        userId: user.id,
        name: data.name,
        type: data.type,
        reportingCurrency: data.reportingCurrency,
        description: data.description ?? null,
      });
      return toView(await this.accounts.save(account, manager));
    });
  }

  async update(user: CurrentUser, accountId: string, input: UpdateAccountInput): Promise<AccountView> {
    const data = parseInput(updateAccountSchema, input);
    return this.uow.run(async (manager) => {
      const account = isUuid(accountId) ? await this.accounts.findForUpdate(user.id, accountId, manager) : null;
      if (!account) throw new NotFoundError(`Account ${accountId} not found`);
      if (data.name !== undefined && (await this.accounts.nameTaken(user.id, data.name, account.id, manager))) {
        throw new ConflictError(`You already have an account named "${data.name}"`);
      }
      if (data.name !== undefined) account.name = data.name;
      if (data.type !== undefined) account.type = data.type;
      if (data.reportingCurrency !== undefined) account.reportingCurrency = data.reportingCurrency;
      if (data.description !== undefined) account.description = data.description ?? null;
      return toView(await this.accounts.save(account, manager));
    });
  }

  /**
   * Deletes an account. An account with transactions is only deleted when
   * the caller says so explicitly; its transactions go with it.
   */
  async delete(user: CurrentUser, accountId: string, input: { deleteTransactions?: boolean } = {}): Promise<{ deleted: true; transactionsDeleted: number }> {
    const { deleteTransactions } = parseInput(deleteAccountSchema, input);
    return this.uow.run(async (manager) => {
      const account = isUuid(accountId) ? await this.accounts.findForUpdate(user.id, accountId, manager) : null;
      if (!account) throw new NotFoundError(`Account ${accountId} not found`);
      const count = await this.transactions.count(user.id, account.id, manager);
      if (count > 0 && !deleteTransactions) {
        throw new ConflictError(
          `Account "${account.name}" has ${count} transaction(s). Delete them first, or pass deleteTransactions: true to delete the account with its transactions.`,
          { transactionCount: count },
        );
      }
      await this.accounts.delete(user.id, account.id, manager);
      return { deleted: true as const, transactionsDeleted: count };
    });
  }
}

export function toView(account: AccountEntity): AccountView {
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    reportingCurrency: account.reportingCurrency,
    description: account.description,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
