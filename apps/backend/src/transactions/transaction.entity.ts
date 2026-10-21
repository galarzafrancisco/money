import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { AccountEntity } from '../accounts/account.entity';
import type { LotSelection, TransactionType } from '../ledger/ledger.types';
import type { SaleLotAllocationEntity } from './sale-lot-allocation.entity';

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

  /** Cash currency affected (deposit, withdrawal, trade, dividend, transfer leg) */
  @Column({ type: 'varchar', length: 3, nullable: true })
  currency: string | null;

  /** Deposit, withdrawal or transfer-leg amount in `currency` */
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

  /** Brokerage on trades; conversion fee (in from_currency) on FX; transfer fee on TRANSFER_OUT */
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

  /** The transfer this leg belongs to (TRANSFER_OUT / TRANSFER_IN only) */
  @Column({ name: 'transfer_id', type: 'uuid', nullable: true })
  transferId: string | null;

  /** The account on the other side of the transfer (TRANSFER_OUT / TRANSFER_IN only) */
  @Column({ name: 'counterparty_account_id', type: 'uuid', nullable: true })
  counterpartyAccountId: string | null;

  /** SELL only: FIFO, or SPECIFIC when the sale names its lots in sale_lot_allocations */
  @Column({ name: 'lot_selection', type: 'varchar', length: 10, nullable: true })
  lotSelection: LotSelection | null;

  /**
   * Not a column. A SPECIFIC sale's allocations in order, attached by
   * TransactionsRepository on every read so the ledger can replay them.
   */
  lotAllocations?: SaleLotAllocationEntity[];

  /** Which field Money calculated from the others (e.g. 'fees' for a three-of-four trade), if any */
  @Column({ name: 'calculated_field', type: 'varchar', length: 20, nullable: true })
  calculatedField: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
