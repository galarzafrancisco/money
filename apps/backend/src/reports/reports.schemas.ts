import { z } from 'zod';
import { DECIMAL_PATTERN } from '../common/decimal';
import { currencyCode } from '../common/validation';

/**
 * "USD:1.52,EUR:1.65" (handy in a query string) or { USD: "1.52", EUR: "1.65" }.
 * Each rate is how many units of the base currency one unit of that currency
 * is worth.
 */
export const fxRates = z
  .union([z.string(), z.record(z.string(), z.union([z.string(), z.number()]))])
  .transform((value, ctx) => {
    const pairs: [string, string][] =
      typeof value === 'string'
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
              const [currency, rate] = part.split(/[:=]/);
              return [currency ?? '', rate ?? ''];
            })
        : Object.entries(value).map(([currency, rate]) => [currency, String(rate)]);
    const rates: Record<string, string> = {};
    for (const [rawCurrency, rawRate] of pairs) {
      const currency = rawCurrency.trim().toUpperCase();
      const rate = rawRate.trim();
      if (!/^[A-Z]{3}$/.test(currency)) {
        ctx.addIssue({ code: 'custom', message: `"${rawCurrency}" is not a 3-letter currency code` });
        continue;
      }
      if (!DECIMAL_PATTERN.test(rate) || !/[1-9]/.test(rate) || rate.startsWith('-')) {
        ctx.addIssue({ code: 'custom', message: `rate for ${currency} must be a positive decimal, e.g. "1.52"` });
        continue;
      }
      rates[currency] = rate;
    }
    return rates;
  })
  .describe(
    'Exchange rates for converted totals: units of baseCurrency per 1 unit of each currency, e.g. { "USD": "1.52" } with baseCurrency AUD. Money does not look rates up; every currency in the report other than baseCurrency needs one.',
  );

/** Shared by both reports, over REST (query string) and MCP */
export const reportOptionsSchema = z
  .object({
    valuation: z
      .enum(['market', 'cost'])
      .default('market')
      .describe('market: holdings at the latest price, falling back to cost base (with a warning) when no usable price exists. cost: holdings at cost base.'),
    baseCurrency: currencyCode
      .optional()
      .describe('Also give totals converted to this currency, using fxRates. Without it, totals are only given per currency.'),
    fxRates: fxRates.optional(),
    rootAccountId: z
      .string()
      .optional()
      .describe('Limit the report to this account and its subaccounts. Works for imported Up accounts too, hidden ones included. Omit for all your accounts.'),
    visibility: z
      .enum(['visible', 'hidden', 'all'])
      .default('visible')
      .describe('Which imported (Up) accounts to include: visible (default), hidden or all. Manual accounts are always included. Ignored when rootAccountId names an account.'),
  })
  .refine((value) => value.fxRates === undefined || value.baseCurrency !== undefined, {
    message: 'fxRates needs baseCurrency',
    path: ['baseCurrency'],
  });
export type ReportOptionsInput = z.input<typeof reportOptionsSchema>;
export type ReportOptions = z.output<typeof reportOptionsSchema>;
