import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * A user-defined logical group over physical accounts, e.g. "Cash" spanning
 * Up accounts and a cash-in-hand account. Not a category and not hierarchy.
 */
@Entity('account_groups')
export class AccountGroupEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  /** Unique per user, ignoring case (UQ_account_groups_user_name) */
  @Column({ type: 'varchar', length: 80 }) name: string;
  @Column({ type: 'text', nullable: true }) description: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' }) updatedAt: Date;
}

/** Exactly one of accountId (Money account) or upAccountId (imported Up account) is set; each is in at most one group */
@Entity('account_group_members')
export class AccountGroupMemberEntity {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'group_id', type: 'uuid' }) groupId: string;
  @Column({ name: 'user_id', type: 'uuid' }) userId: string;
  @Column({ name: 'account_id', type: 'uuid', nullable: true }) accountId: string | null;
  @Column({ name: 'up_account_id', type: 'uuid', nullable: true }) upAccountId: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' }) createdAt: Date;
}
