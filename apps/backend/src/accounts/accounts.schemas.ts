import { z } from 'zod';
import { currencyCode } from '../common/validation';
import { ACCOUNT_TYPES } from './account.entity';

/** Shared by REST bodies and MCP tool inputs */
export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(120).describe('Account name, unique among accounts with the same parent (case-insensitive), e.g. "Stake US shares" or "Term Deposit 1"'),
  type: z.enum(ACCOUNT_TYPES).default('INVESTMENT').describe('INVESTMENT (buys and sells shares), CASH, SUPERANNUATION (retirement savings: everything in it, including subaccounts, counts as super on the dashboard) or OTHER'),
  reportingCurrency: currencyCode.default('AUD').describe('Currency the account is usually reported in. Cash in other currencies can still be held.'),
  description: z.string().trim().max(2000).nullish().describe('Optional free-text notes'),
  parentAccountId: z
    .string()
    .nullish()
    .describe('Make this a subaccount (bucket) of another of your accounts, e.g. "Emergency Fund" under your bank account. Omit for a top-level account.'),
  categoryId: z.string().nullish().describe('Category (from list_categories) for this account. Omit to inherit the parent account\'s category.'),
});
export type CreateAccountInput = z.input<typeof createAccountSchema>;

export const updateAccountSchema = z
  .object({
    name: createAccountSchema.shape.name.optional(),
    type: z.enum(ACCOUNT_TYPES).optional().describe('INVESTMENT, CASH, SUPERANNUATION or OTHER'),
    reportingCurrency: currencyCode.optional(),
    description: z.string().trim().max(2000).nullish().describe('Free-text notes; null clears them'),
    parentAccountId: z
      .string()
      .nullable()
      .optional()
      .describe('Move under another of your accounts; null makes it top-level. Cycles and nesting deeper than 5 levels are refused.'),
    categoryId: z.string().nullable().optional().describe('Category ID; null clears it so the account inherits its parent\'s category'),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'Provide at least one field to change' });
export type UpdateAccountInput = z.input<typeof updateAccountSchema>;

export const deleteAccountSchema = z.object({
  deleteTransactions: z
    .boolean()
    .default(false)
    .describe('Must be true to delete an account that still has transactions; they are deleted with it'),
});
