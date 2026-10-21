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

export const accountListSchema = apiSchema('AccountList', z.array(accountSchema));

export const deleteAccountResultSchema = apiSchema(
  'DeleteAccountResult',
  z.object({ deleted: z.boolean(), transactionsDeleted: z.number().int() }),
);
