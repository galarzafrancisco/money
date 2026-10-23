import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { ZERO, dec, fmt } from '../common/decimal';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { AccountsRepository } from '../accounts/accounts.repository';
import { UnitOfWork } from '../database/unit-of-work';
import { replayLedger } from '../ledger/ledger-engine';
import { isTransferLeg, type RecordableTransactionType } from '../ledger/ledger.types';
import type { CurrentUser } from '../users/users.service';
import { SaleLotAllocationEntity } from './sale-lot-allocation.entity';
import { TransactionEntity } from './transaction.entity';
import { TransactionsRepository } from './transactions.repository';
import { SplitsService } from '../splits/splits.service';
import { materialize, storedInputFields, toTransactionView, type TransactionFields, type TransactionView } from './transaction.mapper';
import {
  UPDATABLE_FIELDS,
  depositSchema,
  dividendSchema,
  fxSchema,
  gainLossSchema,
  listTransactionsSchema,
  recordTransactionSchema,
  sellSchema,
  tradeSchema,
  updateTransactionSchema,
  withdrawalSchema,
  type LotAllocationsInput,
  type RecordTransactionInput,
  type UpdateTransactionInput,
} from './transactions.schemas';

const SCHEMA_BY_TYPE = {
  DEPOSIT: depositSchema,
  WITHDRAWAL: withdrawalSchema,
  GAIN_LOSS: gainLossSchema,
  FX_CONVERSION: fxSchema,
  BUY: tradeSchema,
  SELL: sellSchema,
  DIVIDEND: dividendSchema,
} as const satisfies Record<RecordableTransactionType, unknown>;

/**
 * Records, edits and deletes account activity. These are records of what
 * happened elsewhere (entered by hand or by external automation): nothing
 * here moves money or places trades.
 *
 * Every change runs in one database transaction that locks the account row,
 * re-reads all of the account's transactions, applies the change in memory
 * and replays the whole ledger. If the replay finds a violation (negative
 * cash, overselling, a ticker in two currencies, a sale's lot allocations
 * that no longer fit) nothing is written.
 *
 * A SELL matches lots FIFO unless it gives allocations (specific
 * identification, docs/lot-selection.md). Allocations are stored with the
 * sale and replayed as given; they are never re-matched behind the user's
 * back.
 */
@Injectable()
export class TransactionsService {
  constructor(
    private readonly transactions: TransactionsRepository,
    private readonly accounts: AccountsRepository,
    private readonly uow: UnitOfWork,
    private readonly splits: SplitsService,
  ) {}

  /** REST entry point: the body names the type */
  record(user: CurrentUser, accountId: string, input: RecordTransactionInput): Promise<TransactionView> {
    const { type, ...rest } = parseInput(recordTransactionSchema, input);
    // Other types' schemas would silently drop it; say so instead
    if (type !== 'SELL' && input && typeof input === 'object' && 'allocations' in input) {
      throw new ValidationError('allocations can only be given on a SELL');
    }
    const { allocations, ...fields } = rest as TransactionFields & { allocations?: LotAllocationsInput };
    return this.create(user, accountId, type, fields, allocations);
  }

  /** MCP entry point: the tool names the type */
  recordOfType(user: CurrentUser, accountId: string, type: RecordableTransactionType, input: unknown): Promise<TransactionView> {
    const { allocations, ...fields } = parseInput(SCHEMA_BY_TYPE[type], input) as TransactionFields & { allocations?: LotAllocationsInput };
    return this.create(user, accountId, type, fields, allocations);
  }

  async list(user: CurrentUser, accountId: string, filter: unknown = {}): Promise<TransactionView[]> {
    const parsed = parseInput(listTransactionsSchema, filter);
    await this.requireAccount(user, accountId);
    const rows = await this.transactions.list(user.id, { accountId, ...parsed });
    return rows.map(toTransactionView);
  }

  async get(user: CurrentUser, transactionId: string): Promise<TransactionView> {
    const row = isUuid(transactionId) ? await this.transactions.find(user.id, transactionId) : null;
    if (!row) throw new NotFoundError(`Transaction ${transactionId} not found`);
    return toTransactionView(row);
  }

  /**
   * Edits a transaction. The type and account cannot change (delete and
   * re-record instead). Fields not given keep their values; the field Money
   * calculated last time is recalculated unless it is given; a calculable
   * field set to null is recalculated.
   *
   * A SELL's allocations: given, they replace the old ones; null switches
   * the sale to FIFO; left out, they are kept and must still add up to the
   * (possibly changed) quantity.
   */
  async update(user: CurrentUser, transactionId: string, input: UpdateTransactionInput): Promise<TransactionView> {
    const { allocations, ...patch } = parseInput(updateTransactionSchema, input) as TransactionFields & {
      allocations?: LotAllocationsInput | null;
    };
    return this.uow.run(async (manager) => {
      const existing = await this.lockTransactionAccount(user, transactionId, manager);
      assertNotTransferLeg(existing, 'edit');
      const allowed = UPDATABLE_FIELDS[existing.type];
      const notAllowed = Object.keys(patch).filter((key) => patch[key as keyof TransactionFields] !== undefined && !allowed.includes(key));
      if (allocations !== undefined && !allowed.includes('allocations')) notAllowed.push('allocations');
      if (notAllowed.length > 0) {
        throw new ValidationError(`${notAllowed.join(', ')} cannot be set on a ${existing.type} transaction`, {
          allowed,
        });
      }
      const fields: TransactionFields = { ...storedInputFields(existing) };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) fields[key as keyof TransactionFields] = value;
      }
      const updated = Object.assign(new TransactionEntity(), existing, materialize(existing.type, fields));
      if (existing.type === 'SELL') {
        const kept = existing.lotAllocations?.map((a) => ({ lotId: a.lotTransactionId, quantity: a.quantity }));
        const next = allocations === null ? undefined : allocations ?? (existing.lotSelection === 'SPECIFIC' ? kept : undefined);
        applyLotSelection(updated, next);
      }
      await this.validateLedger(user, existing.accountId, manager, (rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      return this.saveWithAllocations(updated, manager);
    });
  }

  /** Deletes a transaction, unless the remaining ledger would be inconsistent (e.g. deleting a deposit that later buys depend on) */
  async delete(user: CurrentUser, transactionId: string): Promise<{ deleted: true }> {
    return this.uow.run(async (manager) => {
      const existing = await this.lockTransactionAccount(user, transactionId, manager);
      assertNotTransferLeg(existing, 'delete');
      if (existing.type === 'BUY') {
        const sales = await this.transactions.salesAllocatingFrom(user.id, existing.id, manager);
        if (sales.length > 0) {
          throw new ConflictError(
            `This purchase is a lot that ${sales.length} sale(s) take shares from by specific identification. Change those sales' allocations (or switch them to FIFO) first.`,
            { saleTransactionIds: sales },
          );
        }
      }
      await this.validateLedger(user, existing.accountId, manager, (rows) => rows.filter((row) => row.id !== existing.id));
      await this.transactions.delete(user.id, existing.id, manager);
      return { deleted: true as const };
    });
  }

  private async create(
    user: CurrentUser,
    accountId: string,
    type: RecordableTransactionType,
    fields: TransactionFields,
    allocations?: LotAllocationsInput,
  ): Promise<TransactionView> {
    if (allocations !== undefined && type !== 'SELL') throw new ValidationError('allocations can only be given on a SELL');
    const columns = materialize(type, fields);
    return this.uow.run(async (manager) => {
      const account = isUuid(accountId) ? await this.accounts.findForUpdate(user.id, accountId, manager) : null;
      if (!account) throw new NotFoundError(`Account ${accountId} not found`);
      const entity = Object.assign(new TransactionEntity(), {
        id: randomUUID(),
        userId: user.id,
        accountId: account.id,
        type,
        sequence: await this.transactions.nextSequence(account.id, manager),
        ...columns,
        lotSelection: null,
      });
      if (type === 'SELL') applyLotSelection(entity, allocations);
      await this.validateLedger(user, account.id, manager, (rows) => [...rows, entity]);
      return this.saveWithAllocations(entity, manager);
    });
  }

  /** Saves the row, then (for a SELL) its allocations, in the caller's transaction */
  private async saveWithAllocations(entity: TransactionEntity, manager: EntityManager): Promise<TransactionView> {
    const allocations = entity.lotAllocations ?? [];
    const saved = await this.transactions.save(entity, manager);
    if (entity.type === 'SELL') {
      await this.transactions.replaceAllocations(saved, allocations, manager);
      saved.lotAllocations = entity.lotSelection === 'SPECIFIC' ? allocations : undefined;
    }
    return toTransactionView(saved);
  }

  private async requireAccount(user: CurrentUser, accountId: string): Promise<void> {
    const account = isUuid(accountId) ? await this.accounts.find(user.id, accountId) : null;
    if (!account) throw new NotFoundError(`Account ${accountId} not found`);
  }

  /** Finds the user's transaction and locks its account; NotFound for anyone else's */
  private async lockTransactionAccount(user: CurrentUser, transactionId: string, manager: EntityManager): Promise<TransactionEntity> {
    const found = isUuid(transactionId) ? await this.transactions.find(user.id, transactionId, manager) : null;
    if (!found) throw new NotFoundError(`Transaction ${transactionId} not found`);
    await this.accounts.findForUpdate(user.id, found.accountId, manager);
    // Re-read under the lock, in case it changed while we waited
    const current = await this.transactions.find(user.id, transactionId, manager);
    if (!current) throw new NotFoundError(`Transaction ${transactionId} not found`);
    return current;
  }

  private async validateLedger(
    user: CurrentUser,
    accountId: string,
    manager: EntityManager,
    change: (rows: TransactionEntity[]) => TransactionEntity[],
  ): Promise<void> {
    const rows = await this.transactions.listForAccount(user.id, accountId, manager);
    // In the present share basis, like every other replay (docs/stock-splits.md)
    replayLedger(await this.splits.presentEntries(change(rows), { manager }));
  }
}

/**
 * Sets a SELL's lot selection: SPECIFIC with these allocations, or FIFO
 * when there are none. Checks they add up to the sale's quantity here, so
 * the caller gets a 400 before any replay.
 */
function applyLotSelection(sale: TransactionEntity, allocations: { lotId: string; quantity: string }[] | undefined): void {
  if (!allocations) {
    sale.lotSelection = 'FIFO';
    sale.lotAllocations = undefined;
    return;
  }
  const total = allocations.reduce((sum, a) => sum.plus(dec(a.quantity)), ZERO);
  if (!total.eq(dec(sale.quantity!))) {
    throw new ValidationError(
      `Lot allocations add up to ${fmt(total)} shares but the sale is for ${fmt(dec(sale.quantity!))}. Give allocations that add up to the quantity, or set allocations to null for FIFO.`,
      { allocated: fmt(total), quantity: fmt(dec(sale.quantity!)) },
    );
  }
  sale.lotSelection = 'SPECIFIC';
  sale.lotAllocations = allocations.map((a, position) =>
    Object.assign(new SaleLotAllocationEntity(), {
      saleTransactionId: sale.id,
      lotTransactionId: a.lotId.toLowerCase(),
      userId: sale.userId,
      accountId: sale.accountId,
      position,
      quantity: fmt(dec(a.quantity)),
    }),
  );
}

/** A transfer's legs only change together, through the transfer */
function assertNotTransferLeg(transaction: TransactionEntity, action: 'edit' | 'delete'): void {
  if (!isTransferLeg(transaction.type)) return;
  throw new ConflictError(
    `This ${transaction.type} transaction is one side of transfer ${transaction.transferId}. ${action === 'edit' ? 'Edit' : 'Delete'} the transfer instead, so both accounts stay consistent.`,
    { transferId: transaction.transferId },
  );
}
