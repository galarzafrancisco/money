import { Injectable } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { UnitOfWork } from '../database/unit-of-work';
import { TransactionEntity } from '../transactions/transaction.entity';
import { TransferEntity } from './transfer.entity';

export type TransferFilter = { accountId?: string; fromDate?: string; toDate?: string };

/** Every method is scoped to one user */
@Injectable()
export class TransfersRepository {
  constructor(private readonly uow: UnitOfWork) {}

  find(userId: string, transferId: string, manager: EntityManager = this.uow.manager): Promise<TransferEntity | null> {
    return manager.findOne(TransferEntity, { where: { id: transferId, userId } });
  }

  list(userId: string, filter: TransferFilter, manager: EntityManager = this.uow.manager): Promise<TransferEntity[]> {
    const query = manager
      .getRepository(TransferEntity)
      .createQueryBuilder('t')
      .where('t.user_id = :userId', { userId })
      .orderBy('t.date', 'ASC')
      .addOrderBy('t.created_at', 'ASC')
      .addOrderBy('t.id', 'ASC');
    if (filter.accountId) query.andWhere('(t.from_account_id = :accountId OR t.to_account_id = :accountId)', { accountId: filter.accountId });
    if (filter.fromDate) query.andWhere('t.date >= :fromDate', { fromDate: filter.fromDate });
    if (filter.toDate) query.andWhere('t.date <= :toDate', { toDate: filter.toDate });
    return query.getMany();
  }

  /** The TRANSFER_OUT and TRANSFER_IN legs of the given transfers */
  legs(userId: string, transferIds: string[], manager: EntityManager = this.uow.manager): Promise<TransactionEntity[]> {
    if (transferIds.length === 0) return Promise.resolve([]);
    return manager.find(TransactionEntity, { where: { userId, transferId: In(transferIds) } });
  }

  /** How many transfers have this account on either side */
  countForAccount(userId: string, accountId: string, manager: EntityManager = this.uow.manager): Promise<number> {
    return manager
      .getRepository(TransferEntity)
      .createQueryBuilder('t')
      .where('t.user_id = :userId AND (t.from_account_id = :accountId OR t.to_account_id = :accountId)', { userId, accountId })
      .getCount();
  }

  save(transfer: TransferEntity, manager: EntityManager): Promise<TransferEntity> {
    return manager.save(TransferEntity, transfer);
  }

  /** Deletes the transfer; its legs go with it (ON DELETE CASCADE) */
  async delete(userId: string, transferId: string, manager: EntityManager): Promise<void> {
    await manager.delete(TransferEntity, { id: transferId, userId });
  }
}
