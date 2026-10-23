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

const CASH_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'BUY', 'SELL', 'DIVIDEND'] as const;
/** Signed cash effect of a manual transaction (negative: money left the account) */
const CASH_SQL = `(CASE t.type WHEN 'DEPOSIT' THEN t.amount WHEN 'TRANSFER_IN' THEN t.amount WHEN 'SELL' THEN t.total WHEN 'DIVIDEND' THEN t.net_amount
  WHEN 'WITHDRAWAL' THEN -t.amount WHEN 'TRANSFER_OUT' THEN -t.amount WHEN 'BUY' THEN -t.total END)`;

export type ManualSearchFilter = {
  accountIds: string[];
  excludeMatchedByUpAccountIds: string[];
  text?: string;
  fromDate?: string;
  toDate?: string;
  minAmount?: string;
  maxAmount?: string;
  currency?: string;
  direction?: 'out' | 'in';
  transfers: 'exclude' | 'include' | 'only';
  limit: number;
  offset: number;
};

export type ManualSearchResult = {
  rows: { entity: TransactionEntity; cash: string }[];
  total: number;
  byCurrency: { currency: string; count: number; moneyOut: string; moneyIn: string }[];
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

  /**
   * Cash-flow search over manual transactions (deposit, withdrawal, buy, sell,
   * dividend, transfer legs), filtered, sorted (newest first) and paged in the
   * database. `cash` is the signed effect on the cash balance. FX conversions
   * and gain/loss entries have no single cash amount and are not searched.
   * Manual rows matched to an Up transaction in `excludeMatchedByUpAccountIds`
   * are the same event as that Up row and are left out.
   */
  async searchCash(userId: string, filter: ManualSearchFilter, manager: EntityManager = this.uow.manager): Promise<ManualSearchResult> {
    if (filter.accountIds.length === 0) return { rows: [], total: 0, byCurrency: [] };
    const types = filter.transfers === 'only' ? ['TRANSFER_IN', 'TRANSFER_OUT'] : filter.transfers === 'include' ? [...CASH_TYPES, 'TRANSFER_IN', 'TRANSFER_OUT'] : [...CASH_TYPES];
    const query = manager
      .getRepository(TransactionEntity)
      .createQueryBuilder('t')
      .where('t.user_id = :userId', { userId })
      .andWhere('t.account_id IN (:...accountIds)', { accountIds: filter.accountIds })
      .andWhere('t.type IN (:...types)', { types });
    if (filter.excludeMatchedByUpAccountIds.length > 0) {
      query.andWhere(
        `NOT EXISTS (SELECT 1 FROM up_transactions u WHERE u.matched_transaction_id = t.id AND u.deleted_at IS NULL AND u.up_account_id IN (:...matchedScope))`,
        { matchedScope: filter.excludeMatchedByUpAccountIds },
      );
    }
    if (filter.text) {
      const like = `%${filter.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query.andWhere(`(t.description ILIKE :like OR t.symbol ILIKE :like)`, { like });
    }
    if (filter.fromDate) query.andWhere('t.date >= CAST(:from AS date)', { from: filter.fromDate });
    if (filter.toDate) query.andWhere('t.date <= CAST(:to AS date)', { to: filter.toDate });
    if (filter.currency) query.andWhere('t.currency = :currency', { currency: filter.currency });
    if (filter.minAmount !== undefined) query.andWhere(`ABS(${CASH_SQL}) >= CAST(:min AS numeric)`, { min: filter.minAmount });
    if (filter.maxAmount !== undefined) query.andWhere(`ABS(${CASH_SQL}) <= CAST(:max AS numeric)`, { max: filter.maxAmount });
    if (filter.direction === 'out') query.andWhere(`${CASH_SQL} < 0`);
    if (filter.direction === 'in') query.andWhere(`${CASH_SQL} > 0`);

    const page = await query
      .clone()
      .addSelect(CASH_SQL, 'cash')
      .orderBy('t.date', 'DESC')
      .addOrderBy('t.sequence', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .limit(filter.limit)
      .offset(filter.offset)
      .getRawAndEntities();
    const rows = page.entities.map((entity, i) => ({ entity, cash: String(page.raw[i].cash) }));
    const totals = await query
      .clone()
      .select('t.currency', 'currency')
      .addSelect('COUNT(*)', 'count')
      .addSelect(`COALESCE(SUM(CASE WHEN ${CASH_SQL} < 0 THEN -(${CASH_SQL}) ELSE 0 END), 0)`, 'out')
      .addSelect(`COALESCE(SUM(CASE WHEN ${CASH_SQL} > 0 THEN ${CASH_SQL} ELSE 0 END), 0)`, 'in')
      .groupBy('t.currency')
      .orderBy('t.currency', 'ASC')
      .getRawMany<{ currency: string; count: string; out: string; in: string }>();
    const byCurrency = totals.map((r) => ({ currency: r.currency, count: Number(r.count), moneyOut: String(r.out), moneyIn: String(r.in) }));
    return { rows, total: byCurrency.reduce((sum, r) => sum + r.count, 0), byCurrency };
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
