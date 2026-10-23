import { z } from 'zod';

/** Input schemas for discovery search. The same schemas validate REST queries and MCP tool arguments. */

const page = {
  limit: z.coerce.number().int().min(1).max(100).optional().describe('Page size, default 20, at most 100'),
  offset: z.coerce.number().int().min(0).optional().describe('Results to skip (use nextOffset from the previous page)'),
};

export const searchMerchantsShape = {
  q: z.string().trim().min(1).max(100).describe('Part of a merchant name, any case. Spelling variants (BBQ / barbecue), plurals and small typos match too; see matchType.'),
  accountId: z.string().optional().describe('Only merchants seen in this one Up account (from search_accounts), shown even when hidden'),
  visibility: z.enum(['visible', 'hidden', 'all']).optional().describe('Which imported Up accounts to search when no accountId is given: visible (default), hidden or all'),
  ...page,
};
export const searchMerchantsSchema = z.object(searchMerchantsShape);

export const searchAccountsShape = {
  q: z.string().trim().min(1).max(100).optional().describe('Part of an account name, any case. Omit to list accounts in name order.'),
  source: z.enum(['manual', 'up']).optional().describe('Only accounts recorded in Money (manual) or imported from Up (up)'),
  visibility: z.enum(['visible', 'hidden', 'all']).optional().describe('Affects imported Up accounts only: visible (default), hidden or all. Manual accounts are always visible.'),
  ...page,
};
export const searchAccountsSchema = z.object(searchAccountsShape);
