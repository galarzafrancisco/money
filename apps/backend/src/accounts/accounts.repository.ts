import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { UnitOfWork } from '../database/unit-of-work';
import { AccountEntity } from './account.entity';

/** Every method is scoped to one user: an account of another user is never returned */
@Injectable()
export class AccountsRepository {
  constructor(private readonly uow: UnitOfWork) {}

  list(userId: string, manager: EntityManager = this.uow.manager): Promise<AccountEntity[]> {
    return manager.find(AccountEntity, { where: { userId }, order: { name: 'ASC' } });
  }

  find(userId: string, accountId: string, manager: EntityManager = this.uow.manager): Promise<AccountEntity | null> {
    return manager.findOne(AccountEntity, { where: { id: accountId, userId } });
  }

  /** Loads the account and locks its row until the transaction ends, so changes to one account are serialized */
  findForUpdate(userId: string, accountId: string, manager: EntityManager): Promise<AccountEntity | null> {
    return manager
      .getRepository(AccountEntity)
      .createQueryBuilder('account')
      .setLock('pessimistic_write')
      .where('account.id = :accountId AND account.user_id = :userId', { accountId, userId })
      .getOne();
  }

  async nameTaken(userId: string, name: string, exceptId: string | null, manager: EntityManager = this.uow.manager): Promise<boolean> {
    const query = manager
      .getRepository(AccountEntity)
      .createQueryBuilder('account')
      .where('account.user_id = :userId AND lower(account.name) = lower(:name)', { userId, name });
    if (exceptId) query.andWhere('account.id <> :exceptId', { exceptId });
    return (await query.getCount()) > 0;
  }

  save(account: AccountEntity, manager: EntityManager = this.uow.manager): Promise<AccountEntity> {
    return manager.save(AccountEntity, account);
  }

  async delete(userId: string, accountId: string, manager: EntityManager): Promise<void> {
    await manager.delete(AccountEntity, { id: accountId, userId });
  }
}
