import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { UnitOfWork } from '../database/unit-of-work';
import { TransactionEntity } from './transaction.entity';

export type TransactionFilter = {
  accountId?: string;
  type?: string;
  symbol?: string;
  fromDate?: string;
  toDate?: string;
};

/** Every method is scoped to one user */
@Injectable()
export class TransactionsRepository {
  constructor(private readonly uow: UnitOfWork) {}

  listForAccount(userId: string, accountId: string, manager: EntityManager = this.uow.manager): Promise<TransactionEntity[]> {
    return manager.find(TransactionEntity, {
      where: { userId, accountId },
      order: { date: 'ASC', sequence: 'ASC' },
    });
  }

  list(userId: string, filter: TransactionFilter, manager: EntityManager = this.uow.manager): Promise<TransactionEntity[]> {
    const query = manager
      .getRepository(TransactionEntity)
      .createQueryBuilder('t')
      .where('t.user_id = :userId', { userId })
      .orderBy('t.date', 'ASC')
      .addOrderBy('t.sequence', 'ASC');
    if (filter.accountId) query.andWhere('t.account_id = :accountId', { accountId: filter.accountId });
    if (filter.type) query.andWhere('t.type = :type', { type: filter.type });
    if (filter.symbol) query.andWhere('t.symbol = :symbol', { symbol: filter.symbol });
    if (filter.fromDate) query.andWhere('t.date >= :fromDate', { fromDate: filter.fromDate });
    if (filter.toDate) query.andWhere('t.date <= :toDate', { toDate: filter.toDate });
    return query.getMany();
  }

  find(userId: string, transactionId: string, manager: EntityManager = this.uow.manager): Promise<TransactionEntity | null> {
    return manager.findOne(TransactionEntity, { where: { id: transactionId, userId } });
  }

  async count(userId: string, accountId: string, manager: EntityManager = this.uow.manager): Promise<number> {
    return manager.count(TransactionEntity, { where: { userId, accountId } });
  }

  async nextSequence(accountId: string, manager: EntityManager): Promise<number> {
    const row = await manager
      .getRepository(TransactionEntity)
      .createQueryBuilder('t')
      .select('COALESCE(MAX(t.sequence), 0)', 'max')
      .where('t.account_id = :accountId', { accountId })
      .getRawOne<{ max: string | number }>();
    return Number(row?.max ?? 0) + 1;
  }

  save(transaction: TransactionEntity, manager: EntityManager): Promise<TransactionEntity> {
    return manager.save(TransactionEntity, transaction);
  }

  async delete(userId: string, transactionId: string, manager: EntityManager): Promise<void> {
    await manager.delete(TransactionEntity, { id: transactionId, userId });
  }
}
