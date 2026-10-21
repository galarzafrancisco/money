import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { UserEntity } from '../users/user.entity';

export const ACCOUNT_TYPES = ['INVESTMENT', 'CASH', 'OTHER'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

@Entity('accounts')
@Index('IDX_accounts_user', ['userId'])
@Index('IDX_accounts_parent', ['parentAccountId'])
export class AccountEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  /**
   * The account this one is a subaccount (bucket) of, or null for a top-level
   * account. Always the same user's account (composite FK FK_accounts_parent).
   */
  @Column({ name: 'parent_account_id', type: 'uuid', nullable: true })
  parentAccountId: string | null;

  /** The account's own category; null means it inherits from its parent (see docs/categories.md) */
  @Column({ name: 'category_id', type: 'uuid', nullable: true })
  categoryId: string | null;

  /** Unique among siblings (same user and parent), ignoring case (UQ_accounts_user_parent_name) */
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 20 })
  type: AccountType;

  /** Currency the account is usually reported in; cash in any currency can still be held */
  @Column({ name: 'reporting_currency', type: 'varchar', length: 3 })
  reportingCurrency: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
