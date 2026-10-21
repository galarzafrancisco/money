import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { UnitOfWork } from '../database/unit-of-work';
import { SaleLotAllocationEntity } from './sale-lot-allocation.entity';
import { TransactionEntity } from './transaction.entity';

export type TransactionFilter = {
  accountId?: string;
  type?: string;
  symbol?: string;
  fromDate?: string;
  toDate?: string;
};

/**
 * Every method is scoped to one user. Every read attaches a SPECIFIC sale's
 * lot allocations (lotAllocations), so a ledger replay never silently falls
 * back to FIFO for a sale that named its lots.
 */
@Injectable()
export class TransactionsRepository {
  constructor(private readonly uow: UnitOfWork) {}

  async listForAccount(userId: string, accountId: string, manager: EntityManager = this.uow.manager): Promise<TransactionEntity[]> {
    const rows = await manager.find(TransactionEntity, {
      where: { userId, accountId },
      order: { date: 'ASC', sequence: 'ASC' },
    });
    return this.attachAllocations(userId, rows, manager);
  }

  async list(userId: string, filter: TransactionFilter, manager: EntityManager = this.uow.manager): Promise<TransactionEntity[]> {
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
    return this.attachAllocations(userId, await query.getMany(), manager);
  }

  async find(userId: string, transactionId: string, manager: EntityManager = this.uow.manager): Promise<TransactionEntity | null> {
    const row = await manager.findOne(TransactionEntity, { where: { id: transactionId, userId } });
    if (!row) return null;
    const [attached] = await this.attachAllocations(userId, [row], manager);
    return attached;
  }

  /** IDs of the sales that allocate shares from this purchase lot */
  async salesAllocatingFrom(userId: string, lotTransactionId: string, manager: EntityManager = this.uow.manager): Promise<string[]> {
    const rows = await manager.find(SaleLotAllocationEntity, { where: { userId, lotTransactionId }, order: { saleTransactionId: 'ASC' } });
    return rows.map((row) => row.saleTransactionId);
  }

  /**
   * Saves a sale's lot allocations, replacing any it had. The sale row must
   * already be saved; an empty list (FIFO) just removes them.
   */
  async replaceAllocations(sale: TransactionEntity, allocations: SaleLotAllocationEntity[], manager: EntityManager): Promise<void> {
    await manager.delete(SaleLotAllocationEntity, { userId: sale.userId, saleTransactionId: sale.id });
    if (allocations.length > 0) await manager.insert(SaleLotAllocationEntity, allocations);
  }

  private async attachAllocations(userId: string, rows: TransactionEntity[], manager: EntityManager): Promise<TransactionEntity[]> {
    const saleIds = rows.filter((row) => row.lotSelection === 'SPECIFIC').map((row) => row.id);
    const bySale = new Map<string, SaleLotAllocationEntity[]>();
    if (saleIds.length > 0) {
      const allocations = await manager.find(SaleLotAllocationEntity, {
        where: { userId, saleTransactionId: In(saleIds) },
        order: { saleTransactionId: 'ASC', position: 'ASC' },
      });
      for (const allocation of allocations) {
        bySale.set(allocation.saleTransactionId, [...(bySale.get(allocation.saleTransactionId) ?? []), allocation]);
      }
    }
    for (const row of rows) {
      if (row.lotSelection === 'SPECIFIC') row.lotAllocations = bySale.get(row.id) ?? [];
    }
    return rows;
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
