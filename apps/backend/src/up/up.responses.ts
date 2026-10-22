import { z } from 'zod';
import { apiSchema, decimalOut } from '../openapi/api-schemas';

/** REST response shapes (OpenAPI) for the Up! integration, mirroring the views UpService returns */
const accountCounts = z.object({ total: z.number().int(), visible: z.number().int(), hidden: z.number().int() });

export const upStatusSchema = apiSchema(
  'UpStatus',
  z.object({
    configured: z.boolean().describe('false when this server has no UP_ENCRYPTION_KEY, so Up cannot be connected'),
    status: z.enum(['none', 'active', 'rejected', 'disconnected']),
    webhookStatus: z.enum(['none', 'registered', 'failed']).describe('registered: Up pushes changes to Money. Otherwise changes are picked up by sync.'),
    connectedAt: z.string().nullable(),
    lastSyncAt: z.string().nullable(),
    lastError: z.object({ code: z.string(), at: z.string() }).nullable(),
    accounts: accountCounts,
    hint: z.string().nullable().describe('What to do next, when something needs the user'),
  }),
);

export const upAccountSchema = apiSchema(
  'UpAccount',
  z.object({
    id: z.string(),
    upId: z.string(),
    displayName: z.string(),
    accountType: z.string(),
    ownershipType: z.string(),
    currency: z.string(),
    balance: decimalOut("The balance Up reported at the last sync (includes held amounts), in the account's currency"),
    visible: z.boolean().describe('false: imported and tracked but hidden from default views'),
    linkedAccountId: z.string().nullable(),
    categoryId: z.string().nullable().describe('Your Money category for this account, if you set one'),
    source: z.literal('up').describe('Provenance: imported from Up, not recorded in Money'),
    lastSyncedAt: z.string().nullable(),
    removedAt: z.string().nullable().describe('Set when Up stopped listing the account; imported data is kept'),
    upCreatedAt: z.string(),
  }),
);
export const upAccountListSchema = apiSchema('UpAccountList', z.array(upAccountSchema));

export const upTransactionSchema = apiSchema(
  'UpTransaction',
  z.object({
    id: z.string(),
    upId: z.string(),
    accountId: z.string().describe('The UpAccount this belongs to'),
    status: z.enum(['HELD', 'SETTLED']),
    description: z.string(),
    message: z.string().nullable(),
    transactionType: z.string().nullable(),
    currency: z.string(),
    amount: decimalOut('Signed: negative is money out of the Up account'),
    foreignCurrency: z.string().nullable(),
    foreignAmount: decimalOut().nullable(),
    categoryId: z.string().nullable().describe("Up's own category ID, not a Money category"),
    transferUpAccountId: z.string().nullable(),
    createdAt: z.string(),
    settledAt: z.string().nullable(),
    deletedAt: z.string().nullable().describe('Set when Up deleted the transaction; only listed with includeDeleted'),
    matchedTransactionId: z.string().nullable().describe('The manual Money transaction recording the same event; avoid counting both'),
    reconciliation: z.enum(['matched', 'unmatched']),
    source: z.literal('up'),
  }),
);

export const upTransactionPageSchema = apiSchema(
  'UpTransactionPage',
  z.object({ items: z.array(upTransactionSchema), nextOffset: z.number().int().nullable() }),
);

export const upSyncResultSchema = apiSchema(
  'UpSyncResult',
  z.object({ accounts: z.number().int(), transactionsCreated: z.number().int(), transactionsUpdated: z.number().int(), transactionsDeleted: z.number().int(), status: upStatusSchema }),
);

export const upSyncRunSchema = apiSchema(
  'UpSyncRun',
  z.object({
    id: z.string(),
    trigger: z.enum(['connect', 'reconnect', 'manual', 'webhook']),
    status: z.enum(['running', 'succeeded', 'failed']),
    accountsSeen: z.number().int(),
    transactionsCreated: z.number().int(),
    transactionsUpdated: z.number().int(),
    transactionsDeleted: z.number().int(),
    errorCode: z.string().nullable(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
  }),
);
export const upSyncRunListSchema = apiSchema('UpSyncRunList', z.array(upSyncRunSchema));

export const disconnectUpResultSchema = apiSchema(
  'DisconnectUpResult',
  z.object({ disconnected: z.boolean(), purged: z.boolean(), accountsDeleted: z.number().int(), transactionsDeleted: z.number().int(), webhookRemoved: z.boolean() }),
);
