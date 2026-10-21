import { z } from 'zod';
import { isoDate, tickerSymbol, currencyCode } from '../common/validation';
import { fxRates } from '../reports/reports.schemas';

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
  .describe('true or false');

/** Shared by GET /api/valuations and the get_valuation_history tool */
export const valuationHistorySchema = z
  .object({
    fromDate: isoDate.optional().describe('First valuation date (YYYY-MM-DD). Default: 90 days before toDate.'),
    toDate: isoDate.optional().describe('Last valuation date (YYYY-MM-DD). Default: the latest materialised date.'),
    accountId: z.string().optional().describe('Only this account (and its subaccounts unless includeSubaccounts is false). Omit for all your accounts.'),
    includeSubaccounts: booleanish.default(true).describe('With accountId: include its subaccounts (default true)'),
    symbol: tickerSymbol.optional().describe('Only this ticker'),
    include: z
      .enum(['totals', 'holdings'])
      .default('totals')
      .describe('totals: per-day totals per currency (for charts). holdings: also every holding with quantity, price, lots (at most 366 days per request).'),
    baseCurrency: currencyCode.optional().describe('Also convert daily totals to this currency using fxRates'),
    fxRates: fxRates.optional(),
  })
  .refine((value) => value.fxRates === undefined || value.baseCurrency !== undefined, { message: 'fxRates needs baseCurrency', path: ['baseCurrency'] })
  .refine((value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate, { message: 'fromDate must not be after toDate', path: ['fromDate'] });

export type ValuationHistoryInput = z.input<typeof valuationHistorySchema>;

export const recomputeSchema = z.object({
  fromDate: isoDate.describe('Re-value every date from this one (YYYY-MM-DD) on the next job run'),
  accountId: z.string().optional().describe('Only this account and its subaccounts. Omit for all your accounts.'),
});

export type RecomputeInput = z.input<typeof recomputeSchema>;
