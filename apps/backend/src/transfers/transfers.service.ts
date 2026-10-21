import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { AccountsRepository } from '../accounts/accounts.repository';
import { MoneyDecimal, fmt, parseDecimalOrNull } from '../common/decimal';
import { LedgerViolationError, NotFoundError, ValidationError } from '../common/errors';
import { isUuid, parseInput } from '../common/validation';
import { UnitOfWork } from '../database/unit-of-work';
import { replayLedger } from '../ledger/ledger-engine';
import type { TransferLegType } from '../ledger/ledger.types';
import { TransactionEntity } from '../transactions/transaction.entity';
import { toLedgerEntry } from '../transactions/transaction.mapper';
import { TransactionsRepository } from '../transactions/transactions.repository';
import type { CurrentUser } from '../users/users.service';
import { resolveTransfer, type ResolvedTransfer } from './transfer-math';
import { TransferEntity } from './transfer.entity';
import { TransfersRepository } from './transfers.repository';
import {
  createTransferSchema,
  listTransfersSchema,
  updateTransferSchema,
  type CreateTransferInput,
  type UpdateTransferInput,
} from './transfers.schemas';

export type TransferView = {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  date: string;
  description: string | null;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  /** Units of toCurrency per unit of fromCurrency; "1" within one currency */
  rate: string;
  /** Charged in fromCurrency to the source account, on top of fromAmount */
  fees: string;
  /** True when the currencies differ, i.e. the transfer includes a conversion at `rate` */
  isFx: boolean;
  /** The field Money calculated from the others, if any */
  calculatedField: string | null;
  /** The TRANSFER_OUT transaction in the source account */
  outTransactionId: string;
  /** The TRANSFER_IN transaction in the destination account */
  inTransactionId: string;
  createdAt: string;
  updatedAt: string;
};

type AmountFields = { fromAmount?: string | null; toAmount?: string | null; rate?: string | null; fees?: string | null };

/**
 * Records transfers between two of the user's own accounts. These are
 * tracking records only: nothing here moves real money.
 *
 * A transfer and its two legs (TRANSFER_OUT on the source, TRANSFER_IN on the
 * destination) are written in one database transaction that locks both
 * account rows in id order (the global lock order, see docs/data-model.md),
 * then replays both ledgers with the change applied. If either ledger would
 * break (e.g. negative cash in the source, or the destination already spent
 * money an edit removes) nothing is written.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly transfers: TransfersRepository,
    private readonly transactions: TransactionsRepository,
    private readonly accounts: AccountsRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async record(user: CurrentUser, input: CreateTransferInput): Promise<TransferView> {
    const data = parseInput(createTransferSchema, input);
    const fromCurrency = data.fromCurrency;
    const toCurrency = data.toCurrency ?? fromCurrency;
    const amounts = resolveTransfer({
      fromCurrency,
      toCurrency,
      fromAmount: d(data.fromAmount),
      toAmount: d(data.toAmount),
      rate: d(data.rate),
      fees: d(data.fees),
    });
    return this.uow.run(async (manager) => {
      await this.lockAccounts(user, data.fromAccountId, data.toAccountId, manager);
      const transfer = Object.assign(new TransferEntity(), {
        id: randomUUID(),
        userId: user.id,
        fromAccountId: data.fromAccountId,
        toAccountId: data.toAccountId,
        date: data.date,
        description: data.description ?? null,
        fromCurrency,
        toCurrency,
      });
      applyAmounts(transfer, amounts);
      const out = await this.newLeg(transfer, 'TRANSFER_OUT', manager);
      const into = await this.newLeg(transfer, 'TRANSFER_IN', manager);
      await this.validateLedgers(user, transfer, manager, (rows) => [...rows, out, into]);
      const saved = await this.transfers.save(transfer, manager);
      await this.transactions.save(out, manager);
      await this.transactions.save(into, manager);
      return toTransferView(saved, [out, into]);
    });
  }

  async list(user: CurrentUser, filter: unknown = {}): Promise<TransferView[]> {
    const parsed = parseInput(listTransfersSchema, filter);
    if (parsed.accountId !== undefined) {
      const account = isUuid(parsed.accountId) ? await this.accounts.find(user.id, parsed.accountId) : null;
      if (!account) throw new NotFoundError(`Account ${parsed.accountId} not found`);
    }
    const rows = await this.transfers.list(user.id, parsed);
    const legs = await this.transfers.legs(user.id, rows.map((row) => row.id));
    return rows.map((row) => toTransferView(row, legs.filter((leg) => leg.transferId === row.id)));
  }

  async get(user: CurrentUser, transferId: string): Promise<TransferView> {
    const transfer = isUuid(transferId) ? await this.transfers.find(user.id, transferId) : null;
    if (!transfer) throw new NotFoundError(`Transfer ${transferId} not found`);
    return toTransferView(transfer, await this.transfers.legs(user.id, [transfer.id]));
  }

  /**
   * Edits a transfer and both its legs. The accounts cannot change: delete
   * the transfer and record a new one instead.
   */
  async update(user: CurrentUser, transferId: string, input: UpdateTransferInput): Promise<TransferView> {
    if (input && typeof input === 'object' && ('fromAccountId' in input || 'toAccountId' in input)) {
      throw new ValidationError("A transfer's accounts cannot be changed. Delete it and record a new transfer instead.");
    }
    const patch = parseInput(updateTransferSchema, input);
    return this.uow.run(async (manager) => {
      const { transfer, out, into } = await this.lockTransfer(user, transferId, manager);
      const fromCurrency = patch.fromCurrency ?? transfer.fromCurrency;
      const toCurrency = patch.toCurrency ?? transfer.toCurrency;
      const amounts = resolveTransfer({ fromCurrency, toCurrency, ...toDecimals(mergeAmounts(transfer, patch, fromCurrency === toCurrency)) });

      const updated = Object.assign(new TransferEntity(), transfer, {
        date: patch.date ?? transfer.date,
        description: patch.description !== undefined ? (patch.description ?? null) : transfer.description,
        fromCurrency,
        toCurrency,
      });
      applyAmounts(updated, amounts);
      const newOut = Object.assign(new TransactionEntity(), out, legColumns(updated, 'TRANSFER_OUT'));
      const newIn = Object.assign(new TransactionEntity(), into, legColumns(updated, 'TRANSFER_IN'));
      await this.validateLedgers(user, updated, manager, (rows) =>
        rows.map((row) => (row.id === newOut.id ? newOut : row.id === newIn.id ? newIn : row)),
      );
      const saved = await this.transfers.save(updated, manager);
      await this.transactions.save(newOut, manager);
      await this.transactions.save(newIn, manager);
      return toTransferView(saved, [newOut, newIn]);
    });
  }

  /**
   * Deletes a transfer and both legs: the correction for a transfer recorded
   * by mistake. Refused when either ledger depends on it (e.g. the
   * destination already spent the money). To record money that really came
   * back, record a transfer in the opposite direction instead.
   */
  async delete(user: CurrentUser, transferId: string): Promise<{ deleted: true; transactionsDeleted: number }> {
    return this.uow.run(async (manager) => {
      const { transfer, out, into } = await this.lockTransfer(user, transferId, manager);
      const legIds = new Set([out.id, into.id]);
      await this.validateLedgers(user, transfer, manager, (rows) => rows.filter((row) => !legIds.has(row.id)));
      await this.transfers.delete(user.id, transfer.id, manager);
      return { deleted: true as const, transactionsDeleted: 2 };
    });
  }

  /** Locks both accounts in id order; NotFound if either is missing or someone else's */
  private async lockAccounts(user: CurrentUser, fromAccountId: string, toAccountId: string, manager: EntityManager): Promise<void> {
    for (const accountId of [fromAccountId, toAccountId].sort()) {
      const label = accountId === fromAccountId ? 'Source account' : 'Destination account';
      const account = isUuid(accountId) ? await this.accounts.findForUpdate(user.id, accountId, manager) : null;
      if (!account) throw new NotFoundError(`${label} ${accountId} not found`);
    }
  }

  /** Finds the user's transfer, locks both its accounts, and re-reads it and its legs under the locks */
  private async lockTransfer(user: CurrentUser, transferId: string, manager: EntityManager) {
    const found = isUuid(transferId) ? await this.transfers.find(user.id, transferId, manager) : null;
    if (!found) throw new NotFoundError(`Transfer ${transferId} not found`);
    await this.lockAccounts(user, found.fromAccountId, found.toAccountId, manager);
    const transfer = await this.transfers.find(user.id, transferId, manager);
    if (!transfer) throw new NotFoundError(`Transfer ${transferId} not found`);
    const legs = await this.transfers.legs(user.id, [transfer.id], manager);
    const out = legs.find((leg) => leg.type === 'TRANSFER_OUT');
    const into = legs.find((leg) => leg.type === 'TRANSFER_IN');
    if (!out || !into) throw new Error(`Transfer ${transfer.id} is missing a leg`);
    return { transfer, out, into };
  }

  private async newLeg(transfer: TransferEntity, type: TransferLegType, manager: EntityManager): Promise<TransactionEntity> {
    const accountId = type === 'TRANSFER_OUT' ? transfer.fromAccountId : transfer.toAccountId;
    return Object.assign(new TransactionEntity(), {
      id: randomUUID(),
      userId: transfer.userId,
      accountId,
      type,
      sequence: await this.transactions.nextSequence(accountId, manager),
      transferId: transfer.id,
      counterpartyAccountId: type === 'TRANSFER_OUT' ? transfer.toAccountId : transfer.fromAccountId,
      calculatedField: null,
      ...legColumns(transfer, type),
    });
  }

  /** Replays both accounts' ledgers with the change applied; throws on the first violation in either */
  private async validateLedgers(
    user: CurrentUser,
    transfer: TransferEntity,
    manager: EntityManager,
    change: (rows: TransactionEntity[]) => TransactionEntity[],
  ): Promise<void> {
    for (const [side, accountId] of [['source', transfer.fromAccountId], ['destination', transfer.toAccountId]] as const) {
      const rows = await this.transactions.listForAccount(user.id, accountId, manager);
      try {
        replayLedger(change(rows).filter((row) => row.accountId === accountId).map(toLedgerEntry));
      } catch (error) {
        if (!(error instanceof LedgerViolationError)) throw error;
        throw new LedgerViolationError(`In the ${side} account: ${error.message}`, {
          ...error.details,
          accountId,
          side,
          transferId: transfer.id,
        });
      }
    }
  }
}

/** The leg's ledger columns, derived from the transfer */
function legColumns(transfer: TransferEntity, type: TransferLegType): Partial<TransactionEntity> {
  const out = type === 'TRANSFER_OUT';
  return {
    date: transfer.date,
    description: transfer.description,
    currency: out ? transfer.fromCurrency : transfer.toCurrency,
    amount: out ? transfer.fromAmount : transfer.toAmount,
    fees: out ? transfer.fees : '0',
  };
}

function applyAmounts(transfer: TransferEntity, amounts: ResolvedTransfer): void {
  transfer.fromAmount = fmt(amounts.fromAmount);
  transfer.toAmount = fmt(amounts.toAmount);
  transfer.fxRate = fmt(amounts.rate);
  transfer.fees = fmt(amounts.fees);
  transfer.calculatedField = amounts.calculatedField;
}

/**
 * The amount fields an edit resolves from: the stored ones, minus the one
 * Money calculated last time, overridden by the patch (null = recalculate).
 * Within one currency only one amount matters and the rate is always 1: the
 * patched amount wins, otherwise the stored fromAmount is kept.
 */
function mergeAmounts(transfer: TransferEntity, patch: AmountFields, sameCurrency: boolean): AmountFields {
  const fees = patch.fees !== undefined ? patch.fees : transfer.fees;
  if (sameCurrency) {
    const given = { fromAmount: patch.fromAmount ?? undefined, toAmount: patch.toAmount ?? undefined };
    if (given.fromAmount === undefined && given.toAmount === undefined) {
      return { fromAmount: transfer.fromAmount, rate: patch.rate, fees };
    }
    return { ...given, rate: patch.rate, fees };
  }
  const stored: AmountFields = { fromAmount: transfer.fromAmount, toAmount: transfer.toAmount, rate: transfer.fxRate };
  // A rate of 1 left over from a same-currency transfer is not a real FX rate
  if (transfer.fromCurrency === transfer.toCurrency) delete stored.rate;
  if (transfer.calculatedField) delete stored[transfer.calculatedField as keyof AmountFields];
  for (const key of ['fromAmount', 'toAmount', 'rate'] as const) {
    if (patch[key] !== undefined) stored[key] = patch[key];
  }
  return { ...stored, fees };
}

function toDecimals(fields: AmountFields) {
  return {
    fromAmount: d(fields.fromAmount),
    toAmount: d(fields.toAmount),
    rate: d(fields.rate),
    fees: d(fields.fees),
  };
}

function d(value: string | null | undefined): MoneyDecimal | null {
  return parseDecimalOrNull(value ?? null);
}

export function toTransferView(transfer: TransferEntity, legs: TransactionEntity[]): TransferView {
  const s = (value: string) => fmt(new MoneyDecimal(value));
  return {
    id: transfer.id,
    fromAccountId: transfer.fromAccountId,
    toAccountId: transfer.toAccountId,
    date: transfer.date,
    description: transfer.description,
    fromCurrency: transfer.fromCurrency,
    fromAmount: s(transfer.fromAmount),
    toCurrency: transfer.toCurrency,
    toAmount: s(transfer.toAmount),
    rate: s(transfer.fxRate),
    fees: s(transfer.fees),
    isFx: transfer.fromCurrency !== transfer.toCurrency,
    calculatedField: transfer.calculatedField,
    outTransactionId: legs.find((leg) => leg.type === 'TRANSFER_OUT')!.id,
    inTransactionId: legs.find((leg) => leg.type === 'TRANSFER_IN')!.id,
    createdAt: transfer.createdAt.toISOString(),
    updatedAt: transfer.updatedAt.toISOString(),
  };
}
