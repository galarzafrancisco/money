import { z } from 'zod';
import { apiSchema } from '../openapi/api-schemas';
import { reportTotalsSchema } from '../reports/reports.responses';

export const accountGroupMemberSchema = apiSchema(
  'AccountGroupMember',
  z.object({
    kind: z.enum(['account', 'up']),
    id: z.string().describe('The Money account ID or the Up account ID, according to kind'),
    name: z.string(),
    source: z.enum(['manual', 'up']).describe('Provenance: recorded in Money, or imported (read-only) from Up'),
    accountType: z.string().describe('CASH, INVESTMENT, SUPERANNUATION, OTHER for Money accounts; the Up account type for Up'),
    counted: z.boolean().describe('Whether the account is in the group totals'),
    excludedReason: z
      .enum(['hidden', 'removed', 'linked-duplicate'])
      .nullable()
      .describe('Why it is not counted: hidden Up account, Up stopped listing it, or its Money account link is also in this group (same money recorded twice)'),
    totals: reportTotalsSchema.describe("The account's own figures (a Money account's own ledger, not its subaccounts). Shown even when not counted."),
  }),
);

export const accountGroupSchema = apiSchema(
  'AccountGroup',
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    members: z.array(accountGroupMemberSchema),
    totals: reportTotalsSchema.describe('Counted members only, each once'),
    composition: z
      .object({ cash: z.string(), investments: z.string(), superannuation: z.string(), other: z.string() })
      .nullable()
      .describe('Counted total (in the base currency) by kind of account. Only with baseCurrency and fxRates.'),
  }),
);

export const accountGroupsViewSchema = apiSchema(
  'AccountGroupsView',
  z.object({
    asOf: z.string(),
    valuation: z.enum(['market', 'cost']),
    groups: z.array(accountGroupSchema),
    ungrouped: z.array(accountGroupMemberSchema).describe('Physical accounts that are in no group'),
    totals: reportTotalsSchema.describe('Everything counted: groups plus ungrouped. Equals the physical total of your Money accounts and visible Up accounts.'),
    warnings: z.array(z.string()),
    notes: z.array(z.string()),
  }),
);

export const deleteAccountGroupResultSchema = apiSchema('DeleteAccountGroupResult', z.object({ deleted: z.boolean(), membersReleased: z.number().int() }));
