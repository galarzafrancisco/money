import { z } from 'zod';
import { currencyCode } from '../common/validation';
import { ACCOUNT_TYPES } from './account.entity';

/** Shared by REST bodies and MCP tool inputs */
export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(120).describe('Account name, unique per user (case-insensitive), e.g. "Stake US shares"'),
  type: z.enum(ACCOUNT_TYPES).default('INVESTMENT').describe('INVESTMENT (buys and sells shares), CASH or OTHER'),
  reportingCurrency: currencyCode.default('AUD').describe('Currency the account is usually reported in. Cash in other currencies can still be held.'),
  description: z.string().trim().max(2000).nullish().describe('Optional free-text notes'),
});
export type CreateAccountInput = z.input<typeof createAccountSchema>;

export const updateAccountSchema = z
  .object({
    name: createAccountSchema.shape.name.optional(),
    type: z.enum(ACCOUNT_TYPES).optional().describe('INVESTMENT, CASH or OTHER'),
    reportingCurrency: currencyCode.optional(),
    description: z.string().trim().max(2000).nullish().describe('Free-text notes; null clears them'),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'Provide at least one field to change' });
export type UpdateAccountInput = z.input<typeof updateAccountSchema>;

export const deleteAccountSchema = z.object({
  deleteTransactions: z
    .boolean()
    .default(false)
    .describe('Must be true to delete an account that still has transactions; they are deleted with it'),
});
