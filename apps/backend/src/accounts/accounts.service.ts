import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { CategoriesRepository } from '../categories/categories.repository';
import { requireCategoryForAssignment } from '../categories/categories.service';
import { ConflictError, NotFoundError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { UnitOfWork } from '../database/unit-of-work';
import { TransactionsRepository } from '../transactions/transactions.repository';
import { TransfersRepository } from '../transfers/transfers.repository';
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
import { MAX_ACCOUNT_DEPTH, checkNewParent, levelOf } from './hierarchy';

export { isUuid } from '../common/validation';

export type AccountView = {
  id: string;
  name: string;
  type: AccountEntity['type'];
  reportingCurrency: string;
  description: string | null;
  /** The account this is a subaccount (bucket) of; null for a top-level account */
  parentAccountId: string | null;
  /** The account's own category; null means it inherits its parent's (see docs/categories.md) */
  categoryId: string | null;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class AccountsService {
  constructor(
    private readonly accounts: AccountsRepository,
    private readonly transactions: TransactionsRepository,
    private readonly categories: CategoriesRepository,
    private readonly transfers: TransfersRepository,
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
      await this.accounts.lockHierarchy(user.id, manager);
      const parentAccountId = data.parentAccountId ?? null;
      if (parentAccountId) {
        const all = await this.accounts.list(user.id, manager);
        const byId = new Map(all.map((a) => [a.id, a]));
        if (!byId.has(parentAccountId)) throw new NotFoundError(`Parent account ${parentAccountId} not found`);
        if (levelOf(parentAccountId, byId) + 1 > MAX_ACCOUNT_DEPTH) {
          throw new ConflictError(`Subaccounts can be nested at most ${MAX_ACCOUNT_DEPTH} levels deep`, { maxDepth: MAX_ACCOUNT_DEPTH });
        }
      }
      await this.assertNameFree(user.id, data.name, parentAccountId, null, manager);
      if (data.categoryId) await requireCategoryForAssignment(this.categories, user.id, data.categoryId, manager);
      const account = Object.assign(new AccountEntity(), {
        id: randomUUID(),
        userId: user.id,
        name: data.name,
        type: data.type,
        reportingCurrency: data.reportingCurrency,
        description: data.description ?? null,
        parentAccountId,
        categoryId: data.categoryId ?? null,
      });
      return toView(await this.accounts.save(account, manager));
    });
  }

  async update(user: CurrentUser, accountId: string, input: UpdateAccountInput): Promise<AccountView> {
    const data = parseInput(updateAccountSchema, input);
    return this.uow.run(async (manager) => {
      // Lock order: hierarchy (user row) → category being assigned (FOR SHARE) → account row.
      // The category comes before the account because deleting a category locks the category and
      // then the accounts it is assigned to; taking them the other way round here would deadlock.
      await this.accounts.lockHierarchy(user.id, manager);
      if (data.categoryId) await requireCategoryForAssignment(this.categories, user.id, data.categoryId, manager);
      const account = isUuid(accountId) ? await this.accounts.findForUpdate(user.id, accountId, manager) : null;
      if (!account) throw new NotFoundError(`Account ${accountId} not found`);

      const parentAccountId = data.parentAccountId !== undefined ? data.parentAccountId : account.parentAccountId;
      if (data.parentAccountId !== undefined && data.parentAccountId !== null && data.parentAccountId !== account.parentAccountId) {
        await this.assertCanMove(user.id, account.id, data.parentAccountId, manager);
      }
      const name = data.name ?? account.name;
      if (data.name !== undefined || parentAccountId !== account.parentAccountId) {
        await this.assertNameFree(user.id, name, parentAccountId, account.id, manager);
      }

      account.name = name;
      account.parentAccountId = parentAccountId;
      if (data.type !== undefined) account.type = data.type;
      if (data.reportingCurrency !== undefined) account.reportingCurrency = data.reportingCurrency;
      if (data.description !== undefined) account.description = data.description ?? null;
      if (data.categoryId !== undefined) account.categoryId = data.categoryId;
      return toView(await this.accounts.save(account, manager));
    });
  }

  /**
   * Deletes an account. An account with transactions is only deleted when
   * the caller says so explicitly; its transactions go with it. An account
   * with subaccounts is never deleted: move or delete them first. Nor is an
   * account that takes part in transfers: delete the transfers first.
   */
  async delete(user: CurrentUser, accountId: string, input: { deleteTransactions?: boolean } = {}): Promise<{ deleted: true; transactionsDeleted: number }> {
    const { deleteTransactions } = parseInput(deleteAccountSchema, input);
    return this.uow.run(async (manager) => {
      await this.accounts.lockHierarchy(user.id, manager);
      const account = isUuid(accountId) ? await this.accounts.findForUpdate(user.id, accountId, manager) : null;
      if (!account) throw new NotFoundError(`Account ${accountId} not found`);
      const children = await this.accounts.countChildren(user.id, account.id, manager);
      if (children > 0) {
        throw new ConflictError(
          `Account "${account.name}" has ${children} subaccount(s). Move or delete them first.`,
          { subaccountCount: children },
        );
      }
      // Deleting one side of a transfer would leave the other account's ledger with half a transfer
      const transferCount = await this.transfers.countForAccount(user.id, account.id, manager);
      if (transferCount > 0) {
        throw new ConflictError(
          `Account "${account.name}" takes part in ${transferCount} transfer(s) with other accounts. Delete those transfers first.`,
          { transferCount },
        );
      }
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

  private async assertCanMove(userId: string, accountId: string, newParentId: string, manager: EntityManager): Promise<void> {
    const all = await this.accounts.list(userId, manager);
    if (!all.some((a) => a.id === newParentId)) throw new NotFoundError(`Parent account ${newParentId} not found`);
    const check = checkNewParent(accountId, newParentId, all);
    if (check.ok) return;
    if (check.reason === 'too_deep') {
      throw new ConflictError(`Subaccounts can be nested at most ${MAX_ACCOUNT_DEPTH} levels deep; this move would make ${check.depth}`, {
        maxDepth: MAX_ACCOUNT_DEPTH,
        resultingDepth: check.depth,
      });
    }
    throw new ConflictError(
      check.reason === 'self' ? 'An account cannot be its own parent' : 'An account cannot be moved under one of its own subaccounts',
      { reason: check.reason },
    );
  }

  private async assertNameFree(userId: string, name: string, parentAccountId: string | null, exceptId: string | null, manager: EntityManager): Promise<void> {
    if (await this.accounts.nameTaken(userId, name, parentAccountId, exceptId, manager)) {
      throw new ConflictError(
        parentAccountId ? `That account already has a subaccount named "${name}"` : `You already have a top-level account named "${name}"`,
      );
    }
  }
}

export function toView(account: AccountEntity): AccountView {
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    reportingCurrency: account.reportingCurrency,
    description: account.description,
    parentAccountId: account.parentAccountId,
    categoryId: account.categoryId,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}
