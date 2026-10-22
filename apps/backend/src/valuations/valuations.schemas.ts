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
    baseCurrency: currencyCode
      .optional()
      .describe('Also convert daily totals to this currency: at each date\'s historical FX close, or at fxRates if you pass them'),
    fxRates: fxRates.optional().describe('Constant rates for every date instead of historical FX, e.g. USD:1.52 (units of baseCurrency per unit)'),
  })
  .refine((value) => value.fxRates === undefined || value.baseCurrency !== undefined, { message: 'fxRates needs baseCurrency', path: ['baseCurrency'] })
  .refine((value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate, { message: 'fromDate must not be after toDate', path: ['fromDate'] });

export type ValuationHistoryInput = z.input<typeof valuationHistorySchema>;

export const recomputeSchema = z.object({
  fromDate: isoDate.describe('Re-value every date from this one (YYYY-MM-DD) on the next job run'),
  accountId: z.string().optional().describe('Only this account and its subaccounts. Omit for all your accounts.'),
  refreshPrices: booleanish
    .default(false)
    .describe('Also fetch the closes of the symbols traded in scope again from fromDate, replacing stored closes the provider has since corrected. Stored closes are otherwise final.'),
});

/** Shared by GET /api/valuations/as-of and the get_valuation_as_of tool */
export const valuationAsOfSchema = z
  .object({
    date: isoDate.describe('The date (YYYY-MM-DD): holdings at the end of it, valued at its closes. Not after today.'),
    accountId: z.string().optional().describe('Only this account (and its subaccounts unless includeSubaccounts is false). Omit for all your accounts.'),
    includeSubaccounts: booleanish.default(true).describe('With accountId: include its subaccounts (default true)'),
    symbol: tickerSymbol.optional().describe('Only this ticker'),
    baseCurrency: currencyCode.optional().describe('Also convert totals to this currency: at the date\'s historical FX close, or at fxRates if you pass them'),
    fxRates: fxRates.optional().describe('Constant rates instead of historical FX, e.g. USD:1.52'),
  })
  .refine((value) => value.fxRates === undefined || value.baseCurrency !== undefined, { message: 'fxRates needs baseCurrency', path: ['baseCurrency'] });

export type ValuationAsOfInput = z.input<typeof valuationAsOfSchema>;

export type RecomputeInput = z.input<typeof recomputeSchema>;
