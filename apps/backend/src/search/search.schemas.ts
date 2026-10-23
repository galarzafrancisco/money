import { z } from 'zod';
import { currencyCode, decimalString, isoDate } from '../common/validation';

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

const idList = z
  .union([z.array(z.string()), z.string()])
  .transform((value) => (Array.isArray(value) ? value : value.split(',')).map((id) => id.trim()).filter(Boolean));

const timezone = z
  .string()
  .trim()
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return /^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)*$/.test(value);
    } catch {
      return false;
    }
  }, { message: 'must be an IANA time zone such as Australia/Sydney or UTC' });

export const searchTransactionsShape = {
  accountIds: idList.optional().describe('Up account IDs (from search_accounts) to search; REST: comma-separated. Listed accounts are searched even when hidden. Omit to search every account allowed by visibility.'),
  visibility: z.enum(['visible', 'hidden', 'all']).optional().describe('Which imported Up accounts to search when no accountIds are given: visible (default), hidden or all'),
  merchantKey: z.string().regex(/^up:[a-z0-9-]+$/).optional().describe('Exact merchant, a merchantKey from search_merchants. Preferred over merchant.'),
  merchant: z.string().trim().min(1).max(100).optional().describe('One-shot alternative to merchantKey: a merchant name, matched like search_merchants (spelling variants and typos match, so similar merchants can be included; the response lists matchedMerchants). Merchant filters only cover purchases, never transfers between your own accounts.'),
  text: z.string().trim().min(1).max(100).optional().describe('Free text contained in the description, raw text or message, any case. Separate from the merchant filters.'),
  fromDate: isoDate.optional().describe('On or after this local date, inclusive (see timezone). Omit for no lower bound.'),
  toDate: isoDate.optional().describe('On or before this local date, inclusive (see timezone). Omit for no upper bound.'),
  timezone: timezone.optional().describe('IANA time zone used to read fromDate and toDate, default UTC. Use Australia/Sydney (or your local zone) for dates as seen on your statement.'),
  minAmount: decimalString('Smallest amount, inclusive, compared on absolute value (a 50 purchase and a 50 refund both count as 50). Requires currency.').optional(),
  maxAmount: decimalString('Largest amount, inclusive, compared on absolute value. Requires currency.').optional(),
  currency: currencyCode.optional().describe('Only transactions in this currency. Required with minAmount/maxAmount: amounts are never compared across currencies.'),
  direction: z.enum(['out', 'in', 'any']).optional().describe('out: money leaving the account (purchases, withdrawals). in: money arriving (refunds, deposits). any (default).'),
  status: z.enum(['HELD', 'SETTLED']).optional().describe('Only pending (HELD) or SETTLED transactions. Default: both.'),
  transfers: z.enum(['exclude', 'include', 'only']).optional().describe('Transfers between your own Up accounts: exclude (default), include or only. Ignored (always excluded) when a merchant filter is set.'),
  limit: z.coerce.number().int().min(1).max(200).optional().describe('Page size, default 50, at most 200'),
  offset: z.coerce.number().int().min(0).optional().describe('Results to skip (use nextOffset from the previous page)'),
};
export const searchTransactionsSchema = z
  .object(searchTransactionsShape)
  .superRefine((value, ctx) => {
    if ((value.minAmount !== undefined || value.maxAmount !== undefined) && !value.currency) {
      ctx.addIssue({ code: 'custom', path: ['currency'], message: 'is required with minAmount or maxAmount' });
    }
    if (value.merchantKey && value.merchant) {
      ctx.addIssue({ code: 'custom', path: ['merchant'], message: 'give merchantKey or merchant, not both' });
    }
    if (value.fromDate && value.toDate && value.fromDate > value.toDate) {
      ctx.addIssue({ code: 'custom', path: ['fromDate'], message: 'must not be after toDate' });
    }
    if (value.minAmount !== undefined && value.maxAmount !== undefined && Number(value.minAmount) > Number(value.maxAmount)) {
      ctx.addIssue({ code: 'custom', path: ['minAmount'], message: 'must not exceed maxAmount' });
    }
    for (const key of ['minAmount', 'maxAmount'] as const) {
      if (value[key] !== undefined && value[key]!.startsWith('-')) ctx.addIssue({ code: 'custom', path: [key], message: 'is an absolute amount; use direction for out/in' });
    }
  });
