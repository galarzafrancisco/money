import { z } from 'zod';
import { apiSchema } from '../openapi/api-schemas';

const matchType = z.enum(['exact', 'alias', 'prefix', 'partial', 'approximate']).describe(
  'exact: same name apart from case/punctuation. alias: same words in another spelling (BBQ vs Barbeque). prefix: the name starts with the query. partial: every query word is in the name. approximate: allowing small typos. Only "exact" is the same name; the others are candidates to confirm.',
);

export const merchantResultSchema = apiSchema(
  'MerchantSearchResult',
  z.object({
    merchantKey: z.string().describe('Stable identity derived from the name (not a provider ID). Pass it as merchantKey to list_up_transactions. See docs/search.md for its limits.'),
    name: z.string().describe('Display name: the most common spelling of this merchant in your transactions'),
    aliases: z.array(z.string()).describe('Other spellings seen for the same merchant (at most 10)'),
    source: z.literal('up'),
    matchType,
    transactionCount: z.number().int(),
    firstTransactionAt: z.string(),
    lastTransactionAt: z.string(),
  }),
);
export const merchantPageSchema = apiSchema('MerchantSearchPage', z.object({ items: z.array(merchantResultSchema), nextOffset: z.number().int().nullable() }));

export const accountResultSchema = apiSchema(
  'AccountSearchResult',
  z.object({
    id: z.string().describe('Canonical account ID, usable with get_account and list_transactions'),
    name: z.string(),
    source: z.enum(['manual', 'up']),
    type: z.string().describe('Manual: the Money account type. Up: the Up account type (for example TRANSACTIONAL)'),
    currency: z.string(),
    visible: z.boolean().describe('Imported accounts can be hidden from default views; manual accounts are always true'),
    parentAccountId: z.string().nullable(),
    removed: z.boolean().describe('Up no longer lists this account; its data is kept'),
    matchType: matchType.nullable().describe('null when no q was given'),
  }),
);
export const accountPageSchema = apiSchema('AccountSearchPage', z.object({ items: z.array(accountResultSchema), nextOffset: z.number().int().nullable() }));
