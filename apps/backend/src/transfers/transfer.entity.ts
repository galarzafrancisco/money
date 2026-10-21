import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

const decimalColumn = (name: string) => ({ name, type: 'numeric' as const, precision: 30, scale: 10 });

/**
 * A transfer of money between two of the user's own accounts, as recorded by
 * the user or external automation. Money never moves anything itself.
 *
 * The transfer is the source of truth for what happened. It owns two ledger
 * legs in `transactions`: TRANSFER_OUT on the source account (amount =
 * fromAmount, plus fees) and TRANSFER_IN on the destination (amount =
 * toAmount). Legs are created, edited and deleted only together with it.
 *
 * When fromCurrency = toCurrency, toAmount = fromAmount and rate = 1 (CHECK
 * constraint). Otherwise the rate is the explicit FX rate: units of toCurrency
 * per unit of fromCurrency.
 */
@Entity('transfers')
@Index('IDX_transfers_user', ['userId'])
@Index('IDX_transfers_from_account', ['fromAccountId'])
@Index('IDX_transfers_to_account', ['toAccountId'])
export class TransferEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** Same user's account (composite FK); never changes after creation */
  @Column({ name: 'from_account_id', type: 'uuid' })
  fromAccountId: string;

  /** Same user's account (composite FK); never changes after creation */
  @Column({ name: 'to_account_id', type: 'uuid' })
  toAccountId: string;

  /** Economic date, YYYY-MM-DD; both legs share it */
  @Column({ type: 'date' })
  date: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'from_currency', type: 'varchar', length: 3 })
  fromCurrency: string;

  /** Amount that left the source account, excluding fees */
  @Column(decimalColumn('from_amount'))
  fromAmount: string;

  @Column({ name: 'to_currency', type: 'varchar', length: 3 })
  toCurrency: string;

  /** Amount that arrived in the destination account */
  @Column(decimalColumn('to_amount'))
  toAmount: string;

  /** Units of toCurrency per unit of fromCurrency; 1 when the currencies match */
  @Column(decimalColumn('fx_rate'))
  fxRate: string;

  /** Fees charged in fromCurrency to the source account, on top of fromAmount */
  @Column(decimalColumn('fees'))
  fees: string;

  /** Which of fromAmount/toAmount/rate Money calculated, if any */
  @Column({ name: 'calculated_field', type: 'varchar', length: 20, nullable: true })
  calculatedField: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
