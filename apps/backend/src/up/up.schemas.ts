import { z } from 'zod';
import { isoDate } from '../common/validation';

/** Input schemas for the Up! integration. The same schemas validate REST bodies and MCP tool arguments. */

/** The Up personal access token. Sent once to connect, never returned, never logged */
export const connectUpSchema = z.object({
  token: z
    .string()
    .trim()
    .min(8)
    .max(500)
    .describe('Your Up personal access token (from https://api.up.com.au). It is used read-only, stored encrypted and never shown again.'),
});
export type ConnectUpInput = z.input<typeof connectUpSchema>;

export const visibilityFilter = z.enum(['visible', 'hidden', 'all']);

export const listUpAccountsShape = {
  visibility: visibilityFilter.optional().describe('visible (default): the accounts you selected. hidden: the rest. all: every imported account ("show all").'),
};
export const listUpAccountsSchema = z.object(listUpAccountsShape);

export const updateUpAccountShape = {
  visible: z.boolean().optional().describe('Show this Up account in the default views. Hidden accounts are still imported and tracked.'),
  linkedAccountId: z.string().nullable().optional().describe('Optional: map this Up account to one of your Money accounts (from list_accounts). null removes the mapping.'),
};
export const updateUpAccountSchema = z.object(updateUpAccountShape);
export type UpdateUpAccountInput = z.input<typeof updateUpAccountSchema>;

export const setUpVisibilitySchema = z.object({
  visibleAccountIds: z.array(z.string()).max(500).describe('Up account IDs to show. Every other imported Up account becomes hidden (still imported and tracked).'),
});
export type SetUpVisibilityInput = z.input<typeof setUpVisibilitySchema>;

export const listUpTransactionsShape = {
  accountId: z.string().optional().describe('One Up account (from list_up_accounts), shown even when hidden. Without it, only visible accounts unless visibility says otherwise.'),
  visibility: visibilityFilter.optional().describe('Which accounts to include when no accountId is given: visible (default), hidden or all'),
  status: z.enum(['HELD', 'SETTLED']).optional(),
  fromDate: isoDate.optional().describe('Created on or after this date (UTC)'),
  toDate: isoDate.optional().describe('Created on or before this date (UTC)'),
  includeDeleted: z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]).optional().describe('Also list transactions Up has since deleted (kept for provenance)'),
  reconciliation: z.enum(['matched', 'unmatched']).optional().describe('matched: linked to a manual Money transaction. unmatched: not linked.'),
  limit: z.coerce.number().int().min(1).max(500).optional().describe('Page size, default 100'),
  offset: z.coerce.number().int().min(0).optional().describe('Rows to skip (use nextOffset from the previous page)'),
};
export const listUpTransactionsSchema = z.object(listUpTransactionsShape);

export const matchUpTransactionSchema = z.object({
  transactionId: z.string().describe('The manual Money transaction (from list_transactions) that records the same real-world event'),
});
export type MatchUpTransactionInput = z.input<typeof matchUpTransactionSchema>;

export const disconnectUpShape = {
  purge: z.boolean().optional().describe('Also delete everything imported from Up. By default imported data is kept (read-only history).'),
};
export const disconnectUpSchema = z.object(disconnectUpShape);
