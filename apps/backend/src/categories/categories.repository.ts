import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AccountEntity } from '../accounts/account.entity';
import { UnitOfWork } from '../database/unit-of-work';
import { CategoryEntity, HoldingCategoryEntity } from './category.entity';

/** Every method is scoped to one user: another user's category or assignment is never returned */
@Injectable()
export class CategoriesRepository {
  constructor(private readonly uow: UnitOfWork) {}

  list(userId: string, manager: EntityManager = this.uow.manager): Promise<CategoryEntity[]> {
    return manager.find(CategoryEntity, { where: { userId }, order: { name: 'ASC' } });
  }

  find(userId: string, categoryId: string, manager: EntityManager = this.uow.manager): Promise<CategoryEntity | null> {
    return manager.findOne(CategoryEntity, { where: { id: categoryId, userId } });
  }

  /** Loads the category and locks its row, so assignments to it cannot race its deletion */
  findForUpdate(userId: string, categoryId: string, manager: EntityManager): Promise<CategoryEntity | null> {
    return manager
      .getRepository(CategoryEntity)
      .createQueryBuilder('category')
      .setLock('pessimistic_write')
      .where('category.id = :categoryId AND category.user_id = :userId', { categoryId, userId })
      .getOne();
  }

  /** Locks the category row against deletion until the transaction ends (shared lock) */
  findForShare(userId: string, categoryId: string, manager: EntityManager): Promise<CategoryEntity | null> {
    return manager
      .getRepository(CategoryEntity)
      .createQueryBuilder('category')
      .setLock('pessimistic_read')
      .where('category.id = :categoryId AND category.user_id = :userId', { categoryId, userId })
      .getOne();
  }

  async nameTaken(userId: string, name: string, exceptId: string | null, manager: EntityManager = this.uow.manager): Promise<boolean> {
    const query = manager
      .getRepository(CategoryEntity)
      .createQueryBuilder('category')
      .where('category.user_id = :userId AND lower(category.name) = lower(:name)', { userId, name });
    if (exceptId) query.andWhere('category.id <> :exceptId', { exceptId });
    return (await query.getCount()) > 0;
  }

  save(category: CategoryEntity, manager: EntityManager = this.uow.manager): Promise<CategoryEntity> {
    return manager.save(CategoryEntity, category);
  }

  async delete(userId: string, categoryId: string, manager: EntityManager): Promise<void> {
    await manager.delete(CategoryEntity, { id: categoryId, userId });
  }

  /** How many accounts and holdings have this category as their own */
  async usage(userId: string, categoryId: string, manager: EntityManager = this.uow.manager): Promise<{ accounts: number; holdings: number }> {
    const [accounts, holdings] = await Promise.all([
      manager.count(AccountEntity, { where: { userId, categoryId } }),
      manager.count(HoldingCategoryEntity, { where: { userId, categoryId } }),
    ]);
    return { accounts, holdings };
  }

  listHoldingCategories(userId: string, manager: EntityManager = this.uow.manager): Promise<HoldingCategoryEntity[]> {
    return manager.find(HoldingCategoryEntity, { where: { userId }, order: { accountId: 'ASC', symbol: 'ASC' } });
  }

  async setHoldingCategory(userId: string, accountId: string, symbol: string, categoryId: string, manager: EntityManager): Promise<void> {
    await manager.query(
      `INSERT INTO holding_categories (user_id, account_id, symbol, category_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, symbol) DO UPDATE SET category_id = EXCLUDED.category_id, updated_at = now()
       WHERE holding_categories.user_id = EXCLUDED.user_id`,
      [userId, accountId, symbol, categoryId],
    );
  }

  /** True when an assignment was removed */
  async clearHoldingCategory(userId: string, accountId: string, symbol: string, manager: EntityManager): Promise<boolean> {
    const result = await manager.delete(HoldingCategoryEntity, { userId, accountId, symbol });
    return (result.affected ?? 0) > 0;
  }
}
