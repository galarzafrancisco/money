import { z } from 'zod';
import { ACCOUNT_TYPES } from '../accounts/account.entity';
import { apiSchema, decimalOut } from '../openapi/api-schemas';
import { reportItemSchema, reportTotalsSchema } from '../reports/reports.responses';
import { ASSET_CLASSES } from './dashboard-math';

/** REST response shape (OpenAPI), mirroring DashboardService's DashboardView */
const categoryRef = z.object({ id: z.string(), name: z.string(), color: z.string().nullable() }).nullable().describe('null = Uncategorized');
const assetClass = z.enum(ASSET_CLASSES).describe('cash, shares, or super (everything in a SUPERANNUATION account or its subaccounts)');
const priceStatus = z
  .enum(['MARKET', 'STALE', 'MOCK', 'COST_FALLBACK'])
  .describe('MARKET: recent real price. STALE: real price older than stalePriceDays. MOCK: made-up price. COST_FALLBACK: no usable price, valued at cost base.');
const percent = (description: string) => decimalOut(description).nullable();

export const dashboardItemSchema = apiSchema(
  'DashboardItem',
  z.object({
    ...reportItemSchema.shape,
    assetClass,
    priceStatus: priceStatus.nullable().describe('Holdings only; null for cash'),
  }),
);

export const dashboardSchema = apiSchema(
  'Dashboard',
  z.object({
    asOf: z.string(),
    displayCurrency: z.string(),
    priceProvider: z.string(),
    fx: z.object({
      displayCurrency: z.string(),
      complete: z.boolean().describe('Every currency held has a rate, so converted figures are given'),
      rates: z.array(
        z.object({
          currency: z.string(),
          rate: decimalOut('Units of displayCurrency per 1 unit of currency'),
          source: z.enum(['manual', 'market']),
          provider: z.string().nullable(),
          asOf: z.string().nullable(),
          isMock: z.boolean(),
          isStale: z.boolean().describe('The provider could not be reached; this is the last known rate (see asOf)'),
        }),
      ),
      missing: z.array(z.object({ currency: z.string(), reason: z.string() })).describe('Currencies without a rate; converted figures and percentages are null'),
    }),
    valuation: z.object({
      status: z.enum(['COMPLETE', 'PARTIAL']),
      usesMockPrices: z.boolean(),
      holdings: z.number().int(),
      marketPriced: z.number().int(),
      stalePriced: z.number().int(),
      mockPriced: z.number().int(),
      costFallback: z.number().int(),
      oldestPriceAsOf: z.string().nullable(),
      stalePriceDays: z.number().int(),
    }),
    total: reportTotalsSchema,
    assetClasses: z.array(
      z.object({
        assetClass,
        totals: reportTotalsSchema,
        percentOfTotal: percent('Share of total tracked assets'),
        accounts: z.array(
          z.object({ accountId: z.string(), accountPath: z.array(z.string()), totals: reportTotalsSchema, percentOfClass: percent('Share of this asset class') }),
        ),
      }),
    ),
    categories: z.array(
      z.object({ category: categoryRef, totals: reportTotalsSchema, percentOfTotal: percent('Share of total tracked assets'), items: z.array(dashboardItemSchema) }),
    ),
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.enum(ACCOUNT_TYPES),
        subaccounts: z.number().int(),
        totals: reportTotalsSchema.describe('The account plus all its subaccounts'),
        percentOfTotal: percent('Share of total tracked assets'),
      }),
    ),
    shares: z.object({
      totals: reportTotalsSchema.describe('The share portfolio: holdings outside super accounts'),
      percentOfTotal: percent('Share portfolio as a share of total tracked assets'),
      tickers: z.array(
        z.object({
          symbol: z.string(),
          currency: z.string(),
          quantity: decimalOut(),
          value: decimalOut('In the ticker currency'),
          convertedValue: decimalOut('In displayCurrency').nullable(),
          percentOfShares: percent('Denominator: the share portfolio'),
          percentOfTotal: percent('Denominator: total tracked assets'),
          priceStatus,
          price: z.object({ price: decimalOut(), asOf: z.string(), source: z.string(), isMock: z.boolean(), isStale: z.boolean().describe('The provider failed; this is the last known price (see asOf)') }).nullable(),
          positions: z.array(
            z.object({ accountId: z.string(), accountPath: z.array(z.string()), quantity: decimalOut(), value: decimalOut(), basis: z.enum(['cash', 'market', 'cost']) }),
          ),
        }),
      ),
    }),
    warnings: z.array(z.string()),
    notes: z.array(z.string()),
  }),
);
