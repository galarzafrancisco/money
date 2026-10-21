import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { AccountsRepository } from '../accounts/accounts.repository';
import { ConflictError, NotFoundError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { UnitOfWork } from '../database/unit-of-work';
import type { CurrentUser } from '../users/users.service';
import {
  createCategorySchema,
  deleteCategorySchema,
  holdingCategorySchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type HoldingCategoryInput,
  type UpdateCategoryInput,
} from './categories.schemas';
import { CategoriesRepository } from './categories.repository';
import { CategoryEntity, type HoldingCategoryEntity } from './category.entity';

export type CategoryView = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CategoryUsage = { accounts: number; holdings: number };

export type HoldingCategoryView = { accountId: string; symbol: string; categoryId: string; updatedAt: string };

/**
 * User-defined categories, and their assignment to holdings. Assigning a
 * category to an account goes through AccountsService (it is a field of the
 * account). See docs/categories.md for the semantics.
 */
@Injectable()
export class CategoriesService {
  constructor(
    private readonly categories: CategoriesRepository,
    private readonly accounts: AccountsRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async list(user: CurrentUser): Promise<CategoryView[]> {
    return (await this.categories.list(user.id)).map(toCategoryView);
  }

  async get(user: CurrentUser, categoryId: string): Promise<CategoryView & { usage: CategoryUsage }> {
    const category = isUuid(categoryId) ? await this.categories.find(user.id, categoryId) : null;
    if (!category) throw new NotFoundError(`Category ${categoryId} not found`);
    return { ...toCategoryView(category), usage: await this.categories.usage(user.id, category.id) };
  }

  async create(user: CurrentUser, input: CreateCategoryInput): Promise<CategoryView> {
    const data = parseInput(createCategorySchema, input);
    return this.uow.run(async (manager) => {
      if (await this.categories.nameTaken(user.id, data.name, null, manager)) {
        throw new ConflictError(`You already have a category named "${data.name}"`);
      }
      const category = Object.assign(new CategoryEntity(), {
        id: randomUUID(),
        userId: user.id,
        name: data.name,
        description: data.description ?? null,
        color: data.color?.toLowerCase() ?? null,
      });
      return toCategoryView(await this.categories.save(category, manager));
    });
  }

  async update(user: CurrentUser, categoryId: string, input: UpdateCategoryInput): Promise<CategoryView> {
    const data = parseInput(updateCategorySchema, input);
    return this.uow.run(async (manager) => {
      const category = isUuid(categoryId) ? await this.categories.findForUpdate(user.id, categoryId, manager) : null;
      if (!category) throw new NotFoundError(`Category ${categoryId} not found`);
      if (data.name !== undefined && (await this.categories.nameTaken(user.id, data.name, category.id, manager))) {
        throw new ConflictError(`You already have a category named "${data.name}"`);
      }
      if (data.name !== undefined) category.name = data.name;
      if (data.description !== undefined) category.description = data.description ?? null;
      if (data.color !== undefined) category.color = data.color?.toLowerCase() ?? null;
      return toCategoryView(await this.categories.save(category, manager));
    });
  }

  /**
   * Deletes a category. A category that is assigned to any account or holding
   * is only deleted with unassign: true; the assignments are cleared and those
   * items fall back to the category they inherit.
   */
  async delete(user: CurrentUser, categoryId: string, input: { unassign?: boolean } = {}): Promise<{ deleted: true; unassigned: CategoryUsage }> {
    const { unassign } = parseInput(deleteCategorySchema, input);
    return this.uow.run(async (manager) => {
      const category = isUuid(categoryId) ? await this.categories.findForUpdate(user.id, categoryId, manager) : null;
      if (!category) throw new NotFoundError(`Category ${categoryId} not found`);
      const usage = await this.categories.usage(user.id, category.id, manager);
      if ((usage.accounts > 0 || usage.holdings > 0) && !unassign) {
        throw new ConflictError(
          `Category "${category.name}" is assigned to ${usage.accounts} account(s) and ${usage.holdings} holding(s). Pass unassign: true to delete it and clear those assignments.`,
          usage,
        );
      }
      // FK_accounts_category sets accounts' category_id to null; holding assignments cascade
      await this.categories.delete(user.id, category.id, manager);
      return { deleted: true as const, unassigned: usage };
    });
  }

  async listHoldingCategories(user: CurrentUser, accountId?: string): Promise<HoldingCategoryView[]> {
    if (accountId !== undefined) await this.requireAccount(user, accountId);
    const rows = await this.categories.listHoldingCategories(user.id);
    return rows.filter((row) => accountId === undefined || row.accountId === accountId).map(toHoldingCategoryView);
  }

  /**
   * Sets or clears the category of one holding: a symbol within one account.
   * The symbol does not have to be held right now, so an assignment survives
   * selling out and buying back in.
   */
  async setHoldingCategory(
    user: CurrentUser,
    accountId: string,
    input: HoldingCategoryInput,
  ): Promise<{ accountId: string; symbol: string; categoryId: string | null }> {
    const data = parseInput(holdingCategorySchema, input);
    return this.uow.run(async (manager) => {
      const account = await this.requireAccount(user, accountId, manager);
      if (data.categoryId === null) {
        await this.categories.clearHoldingCategory(user.id, account.id, data.symbol, manager);
        return { accountId: account.id, symbol: data.symbol, categoryId: null };
      }
      await requireCategoryForAssignment(this.categories, user.id, data.categoryId, manager);
      await this.categories.setHoldingCategory(user.id, account.id, data.symbol, data.categoryId, manager);
      return { accountId: account.id, symbol: data.symbol, categoryId: data.categoryId };
    });
  }

  private async requireAccount(user: CurrentUser, accountId: string, manager?: EntityManager) {
    const account = isUuid(accountId) ? await this.accounts.find(user.id, accountId, manager) : null;
    if (!account) throw new NotFoundError(`Account ${accountId} not found`);
    return account;
  }
}

/**
 * Checks that the category exists and is the user's, and holds a shared lock
 * on it until the transaction ends, so it cannot be deleted mid-assignment.
 */
export async function requireCategoryForAssignment(
  categories: CategoriesRepository,
  userId: string,
  categoryId: string,
  manager: EntityManager,
): Promise<CategoryEntity> {
  const category = isUuid(categoryId) ? await categories.findForShare(userId, categoryId, manager) : null;
  if (!category) throw new NotFoundError(`Category ${categoryId} not found`);
  return category;
}

export function toCategoryView(category: CategoryEntity): CategoryView {
  return {
    id: category.id,
    name: category.name,
    description: category.description,
    color: category.color,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

function toHoldingCategoryView(row: HoldingCategoryEntity): HoldingCategoryView {
  return { accountId: row.accountId, symbol: row.symbol, categoryId: row.categoryId, updatedAt: row.updatedAt.toISOString() };
}
