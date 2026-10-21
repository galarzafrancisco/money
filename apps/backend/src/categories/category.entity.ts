import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * A user-defined way of classifying money, e.g. "alpha-high-risk",
 * "boring-etf" or "emergency". Categories are free text, not an enum of
 * asset types. They say how the user thinks about money, not where it is
 * held (that is the account hierarchy).
 */
@Entity('categories')
export class CategoryEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** Unique per user, ignoring case (UQ_categories_user_name) */
  @Column({ type: 'varchar', length: 80 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Optional #rrggbb for dashboards */
  @Column({ type: 'varchar', length: 7, nullable: true })
  color: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * The category of one holding (a symbol within one account), e.g. TSLA in
 * the Stake account → alpha-high-risk. Holdings are derived from
 * transactions, so the assignment is keyed by (account, symbol) and survives
 * the position being sold and bought again.
 */
@Entity('holding_categories')
export class HoldingCategoryEntity {
  @PrimaryColumn({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @PrimaryColumn({ type: 'varchar', length: 32 })
  symbol: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'category_id', type: 'uuid' })
  categoryId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
