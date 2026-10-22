import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { UnitOfWork } from '../database/unit-of-work';
import { AccountGroupEntity, AccountGroupMemberEntity } from './account-group.entity';

/** Every method is scoped to one user */
@Injectable()
export class AccountGroupsRepository {
  constructor(private readonly uow: UnitOfWork) {}

  list(userId: string, manager: EntityManager = this.uow.manager): Promise<AccountGroupEntity[]> {
    return manager.find(AccountGroupEntity, { where: { userId }, order: { name: 'ASC' } });
  }

  find(userId: string, id: string, manager: EntityManager = this.uow.manager): Promise<AccountGroupEntity | null> {
    return manager.findOne(AccountGroupEntity, { where: { id, userId } });
  }

  /** Locks the group row until the transaction ends, so membership changes to one group are serialized */
  findForUpdate(userId: string, id: string, manager: EntityManager): Promise<AccountGroupEntity | null> {
    return manager
      .getRepository(AccountGroupEntity)
      .createQueryBuilder('g')
      .setLock('pessimistic_write')
      .where('g.id = :id AND g.user_id = :userId', { id, userId })
      .getOne();
  }

  async nameTaken(userId: string, name: string, exceptId: string | null, manager: EntityManager = this.uow.manager): Promise<boolean> {
    const query = manager
      .getRepository(AccountGroupEntity)
      .createQueryBuilder('g')
      .where('g.user_id = :userId AND lower(g.name) = lower(:name)', { userId, name });
    if (exceptId) query.andWhere('g.id <> :exceptId', { exceptId });
    return (await query.getCount()) > 0;
  }

  save(group: AccountGroupEntity, manager: EntityManager = this.uow.manager): Promise<AccountGroupEntity> {
    return manager.save(AccountGroupEntity, group);
  }

  async delete(userId: string, id: string, manager: EntityManager): Promise<void> {
    await manager.delete(AccountGroupEntity, { id, userId });
  }

  listMembers(userId: string, manager: EntityManager = this.uow.manager): Promise<AccountGroupMemberEntity[]> {
    return manager.find(AccountGroupMemberEntity, { where: { userId }, order: { createdAt: 'ASC', id: 'ASC' } });
  }

  async removeMembers(userId: string, groupId: string, manager: EntityManager): Promise<void> {
    await manager.delete(AccountGroupMemberEntity, { userId, groupId });
  }

  async removeAccountFromAnyGroup(userId: string, ref: { accountId?: string; upAccountId?: string }, manager: EntityManager): Promise<void> {
    await manager.delete(AccountGroupMemberEntity, ref.accountId ? { userId, accountId: ref.accountId } : { userId, upAccountId: ref.upAccountId });
  }

  addMember(member: AccountGroupMemberEntity, manager: EntityManager): Promise<AccountGroupMemberEntity> {
    return manager.save(AccountGroupMemberEntity, member);
  }
}
