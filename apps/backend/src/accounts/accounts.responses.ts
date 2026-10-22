import { z } from 'zod';
import { apiSchema } from '../openapi/api-schemas';
import { ACCOUNT_TYPES } from './account.entity';

/** REST response shapes (OpenAPI). They mirror the views AccountsService returns. */
export const accountSchema = apiSchema(
  'Account',
  z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(ACCOUNT_TYPES),
    reportingCurrency: z.string(),
    description: z.string().nullable(),
    parentAccountId: z.string().nullable().describe('The account this is a subaccount (bucket) of; null for a top-level account'),
    categoryId: z.string().nullable().describe("The account's own category; null means it inherits its parent's"),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

/** An account as read back: manual or imported from Up, same shape */
export const unifiedAccountSchema = apiSchema(
  'UnifiedAccount',
  accountSchema.extend({
    source: z.enum(['manual', 'up']).describe('manual: recorded in Money. up: imported read-only from Up and kept in sync automatically'),
    visible: z.boolean().describe('Imported accounts can be hidden from default views; manual accounts are always true'),
    balances: z.array(z.object({ currency: z.string(), amount: z.string() })).describe('Cash held per currency (manual: replayed from the ledger; Up: the balance Up last reported)'),
  }),
);

export const unifiedAccountListSchema = apiSchema('UnifiedAccountList', z.array(unifiedAccountSchema));

export const accountListSchema = apiSchema('AccountList', z.array(accountSchema));

export const deleteAccountResultSchema = apiSchema(
  'DeleteAccountResult',
  z.object({ deleted: z.boolean(), transactionsDeleted: z.number().int() }),
);
