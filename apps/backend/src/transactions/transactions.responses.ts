import { z } from 'zod';
import { TRANSACTION_TYPES } from '../ledger/ledger.types';
import { apiSchema, decimalOut } from '../openapi/api-schemas';

/**
 * REST response shape of a transaction (OpenAPI). Common fields are always
 * present; the others only for the types they apply to (see toTransactionView).
 */
export const transactionSchema = apiSchema(
  'Transaction',
  z.object({
    id: z.string(),
    accountId: z.string(),
    type: z.enum(TRANSACTION_TYPES),
    date: z.string(),
    sequence: z.number().int().describe('Order recorded within the date'),
    description: z.string().nullable(),
    calculatedField: z.string().nullable().describe('The field Money calculated from the others, if any'),
    createdAt: z.string(),
    updatedAt: z.string(),
    // DEPOSIT, WITHDRAWAL, GAIN_LOSS (signed), BUY, SELL, DIVIDEND, TRANSFER_*
    currency: z.string().nullable().optional(),
    amount: decimalOut().nullable().optional(),
    externalCurrency: z.string().nullable().optional(),
    externalAmount: decimalOut().nullable().optional(),
    // FX_CONVERSION
    fromCurrency: z.string().nullable().optional(),
    fromAmount: decimalOut().nullable().optional(),
    toCurrency: z.string().nullable().optional(),
    toAmount: decimalOut().nullable().optional(),
    rate: decimalOut().nullable().optional(),
    // BUY, SELL (fees also FX_CONVERSION, TRANSFER_OUT)
    symbol: z.string().nullable().optional(),
    quantity: decimalOut().nullable().optional(),
    unitPrice: decimalOut().nullable().optional(),
    fees: decimalOut().nullable().optional(),
    total: decimalOut().nullable().optional(),
    lotSelection: z.enum(['FIFO', 'SPECIFIC']).optional().describe('SELL only'),
    allocations: z
      .array(z.object({ lotId: z.string(), quantity: decimalOut() }))
      .nullable()
      .optional()
      .describe('SELL only: the lots a SPECIFIC sale names; null for FIFO'),
    // DIVIDEND
    grossAmount: decimalOut().nullable().optional(),
    withholdingTax: decimalOut().nullable().optional(),
    netAmount: decimalOut().nullable().optional(),
    frankingCredits: decimalOut().nullable().optional(),
    // TRANSFER_OUT, TRANSFER_IN
    transferId: z.string().nullable().optional(),
    counterpartyAccountId: z.string().nullable().optional(),
  }),
);

export const transactionListSchema = apiSchema('TransactionList', z.array(transactionSchema));
export const deleteTransactionResultSchema = apiSchema('DeleteTransactionResult', z.object({ deleted: z.boolean() }));

/** A transaction of any account, manual or imported from Up. Up rows are DEPOSIT/WITHDRAWAL by sign and carry the Up-specific fields below. */
export const unifiedTransactionSchema = apiSchema(
  'UnifiedTransaction',
  z.object({
    id: z.string(),
    accountId: z.string(),
    type: z.enum(TRANSACTION_TYPES),
    date: z.string(),
    createdAt: z.string(),
    source: z.enum(['manual', 'up']),
    sequence: z.number().int().optional().describe('Manual transactions only: order recorded within the date'),
    description: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    amount: decimalOut().nullable().optional(),
    status: z.string().optional().describe('Up only'),
    message: z.string().nullable().optional().describe('Up only'),
    foreignCurrency: z.string().nullable().optional().describe('Up only'),
    foreignAmount: decimalOut().nullable().optional().describe('Up only'),
    settledAt: z.string().nullable().optional().describe('Up only'),
    reconciliation: z.enum(['matched', 'unmatched']).optional().describe('Up only'),
  }).catchall(z.unknown()),
);

export const unifiedTransactionListSchema = apiSchema('UnifiedTransactionList', z.array(unifiedTransactionSchema));
