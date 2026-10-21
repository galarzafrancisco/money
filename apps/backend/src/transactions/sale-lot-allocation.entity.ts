import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * How many shares a SPECIFIC sale took from one purchase lot. The lot is
 * the BUY transaction it came from. Sale and lot share the user and account
 * (enforced by composite foreign keys, see the migration).
 */
@Entity('sale_lot_allocations')
export class SaleLotAllocationEntity {
  @PrimaryColumn({ name: 'sale_transaction_id', type: 'uuid' })
  saleTransactionId: string;

  @PrimaryColumn({ name: 'lot_transaction_id', type: 'uuid' })
  lotTransactionId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  /** Order the allocations were given in; the last one takes rounding remainders */
  @Column({ type: 'integer' })
  position: number;

  @Column({ type: 'numeric', precision: 30, scale: 10 })
  quantity: string;
}
