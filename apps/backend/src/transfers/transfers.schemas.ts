import { z } from 'zod';
import { currencyCode, decimalString, isoDate } from '../common/validation';

/**
 * Input schemas for transfers between two of the user's accounts. The same
 * schemas validate REST bodies and MCP tool arguments.
 */
export const createTransferShape = {
  fromAccountId: z.string().describe('Account the money left (from list_accounts)'),
  toAccountId: z.string().describe('Account the money arrived in (from list_accounts); must differ from fromAccountId'),
  date: isoDate,
  description: z.string().trim().max(2000).nullish().describe('Optional note, e.g. the bank reference'),
  fromCurrency: currencyCode.describe('Currency debited from the source account'),
  toCurrency: currencyCode.optional().describe('Currency credited to the destination account. Defaults to fromCurrency.'),
  fromAmount: decimalString('Amount that left the source account, excluding fees').optional(),
  toAmount: decimalString('Amount that arrived in the destination account').optional(),
  rate: decimalString('FX rate: units of toCurrency per unit of fromCurrency. Only for transfers between currencies; 1 (or omitted) when they match.').optional(),
  fees: decimalString('Fees charged in fromCurrency to the source account, on top of fromAmount. Default 0.').optional(),
};

export const createTransferSchema = z
  .object(createTransferShape)
  .refine((value) => value.fromAccountId !== value.toAccountId, {
    message: 'fromAccountId and toAccountId must be different accounts',
    path: ['toAccountId'],
  });
export type CreateTransferInput = z.input<typeof createTransferSchema>;

const nullableDecimal = (description: string) => decimalString(description).nullable().optional();

/**
 * An edit. The accounts cannot change (delete and re-record instead). Fields
 * left out keep their values; the field Money calculated last time is
 * recalculated unless given; a calculable field set to null is recalculated.
 */
export const updateTransferShape = {
  date: isoDate.optional(),
  description: z.string().trim().max(2000).nullish(),
  fromCurrency: currencyCode.optional(),
  toCurrency: currencyCode.optional(),
  fromAmount: nullableDecimal('Amount that left the source; null recalculates it'),
  toAmount: nullableDecimal('Amount that arrived; null recalculates it'),
  rate: nullableDecimal('FX rate (toCurrency per fromCurrency); null recalculates it'),
  fees: nullableDecimal('Fees in fromCurrency; null sets 0'),
};
export const updateTransferSchema = z
  .object(updateTransferShape)
  .strict()
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'Provide at least one field to change' });
export type UpdateTransferInput = z.input<typeof updateTransferSchema>;

export const listTransfersShape = {
  accountId: z.string().optional().describe('Only transfers into or out of this account'),
  fromDate: isoDate.optional().describe('Only transfers on or after this date'),
  toDate: isoDate.optional().describe('Only transfers on or before this date'),
};
export const listTransfersSchema = z.object(listTransfersShape);
