import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { AccountEntity } from '../accounts/account.entity';
import type { TransactionType } from '../ledger/ledger.types';

const decimalColumn = (name: string) => ({ name, type: 'numeric' as const, precision: 30, scale: 10, nullable: true });

/**
 * One recorded activity in an account. Which columns are set depends on the
 * type (see the CHECK constraints in the migration). Amounts are numeric
 * strings, read and written with decimal.js, never as JS numbers.
 *
 * user_id duplicates the account's owner so that every query can be scoped
 * by user directly.
 */
@Entity('transactions')
@Index('IDX_transactions_account_order', ['accountId', 'date', 'sequence'])
@Index('IDX_transactions_user', ['userId'])
export class TransactionEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @ManyToOne(() => AccountEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'account_id' })
  account?: AccountEntity;

  @Column({ type: 'varchar', length: 20 })
  type: TransactionType;

  /** Economic date, YYYY-MM-DD */
  @Column({ type: 'date' })
  date: string;

  /** Per-account insertion order; breaks ties between transactions on the same date */
  @Column({ type: 'integer' })
  sequence: number;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Cash currency affected (deposit, withdrawal, trade, dividend) */
  @Column({ type: 'varchar', length: 3, nullable: true })
  currency: string | null;

  /** Deposit or withdrawal amount in `currency` */
  @Column(decimalColumn('amount'))
  amount: string | null;

  /** The other side of a deposit or withdrawal, e.g. the AUD that left the bank for a USD deposit. Informational. */
  @Column({ name: 'external_currency', type: 'varchar', length: 3, nullable: true })
  externalCurrency: string | null;

  @Column(decimalColumn('external_amount'))
  externalAmount: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  symbol: string | null;

  @Column(decimalColumn('quantity'))
  quantity: string | null;

  @Column(decimalColumn('unit_price'))
  unitPrice: string | null;

  /** Brokerage on trades; conversion fee (in from_currency) on FX */
  @Column(decimalColumn('fees'))
  fees: string | null;

  /** BUY: cash paid incl. fees. SELL: cash received after fees. */
  @Column(decimalColumn('total'))
  total: string | null;

  @Column({ name: 'from_currency', type: 'varchar', length: 3, nullable: true })
  fromCurrency: string | null;

  @Column(decimalColumn('from_amount'))
  fromAmount: string | null;

  @Column({ name: 'to_currency', type: 'varchar', length: 3, nullable: true })
  toCurrency: string | null;

  @Column(decimalColumn('to_amount'))
  toAmount: string | null;

  /** Units of to_currency per unit of from_currency */
  @Column(decimalColumn('fx_rate'))
  fxRate: string | null;

  @Column(decimalColumn('gross_amount'))
  grossAmount: string | null;

  @Column(decimalColumn('withholding_tax'))
  withholdingTax: string | null;

  @Column(decimalColumn('net_amount'))
  netAmount: string | null;

  /** Australian franking credits attached to a dividend. Not cash; recorded for tax reporting. */
  @Column(decimalColumn('franking_credits'))
  frankingCredits: string | null;

  /** Which field Money calculated from the others (e.g. 'fees' for a three-of-four trade), if any */
  @Column({ name: 'calculated_field', type: 'varchar', length: 20, nullable: true })
  calculatedField: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
