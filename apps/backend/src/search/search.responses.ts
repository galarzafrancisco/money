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

export const transactionSearchItemSchema = apiSchema(
  'TransactionSearchItem',
  z.object({
    id: z.string(),
    accountId: z.string().describe('The account (search_accounts), manual or imported from Up'),
    merchant: z.string().nullable().describe("Up's merchant/counterparty label; null for manual transactions, which have no merchant"),
    merchantKey: z.string().nullable().describe('Key of this merchant (see search_merchants); null for manual transactions'),
    date: z.string().describe('Up: when Up created the transaction, UTC ISO timestamp. Manual: the recorded date, YYYY-MM-DD'),
    amount: z.string().describe('Signed decimal: negative is money out'),
    direction: z.enum(['out', 'in']),
    currency: z.string(),
    status: z.enum(['HELD', 'SETTLED']),
    transfer: z.boolean().describe('true for a transfer between your own Up accounts'),
    note: z.string().nullable().describe('Up: the message attached to the transaction. Manual: its description.'),
    source: z.enum(['up', 'manual']).describe('Provenance: imported from Up, or recorded in Money'),
    type: z.string().nullable().describe('Manual transactions: DEPOSIT, WITHDRAWAL, BUY, SELL, DIVIDEND, TRANSFER_IN or TRANSFER_OUT. null for Up.'),
    reconciliation: z.enum(['matched', 'unmatched']).nullable().describe('matched: a manual Money transaction records the same event; the manual one is not listed here, so nothing is counted twice. null for manual rows.'),
    matchedTransactionId: z.string().nullable(),
  }),
);

export const transactionSearchPageSchema = apiSchema(
  'TransactionSearchPage',
  z.object({
    items: z.array(transactionSearchItemSchema).describe('Newest first, ties by id'),
    nextOffset: z.number().int().nullable().describe('Pass as offset for the next page; null on the last page. Nothing is truncated silently.'),
    summary: z.object({
      totalCount: z.number().int().describe('All matching transactions, not just this page'),
      byCurrency: z.array(
        z.object({
          currency: z.string(),
          count: z.number().int(),
          moneyOut: z.string().describe('Sum of the matching outgoing amounts, as a positive number'),
          moneyIn: z.string().describe('Sum of the matching incoming amounts'),
          net: z.string().describe('moneyIn - moneyOut'),
        }),
      ).describe('Totals over every match, never mixed across currencies'),
    }),
    matchedMerchants: z.array(z.object({ merchantKey: z.string(), name: z.string() })).nullable().describe('Which merchants a merchant name resolved to; null when no merchant filter was given'),
    scope: z.object({ accountCount: z.number().int(), timezone: z.string() }),
  }),
);
