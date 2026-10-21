import { z } from 'zod';
import { apiSchema, decimalOut } from '../openapi/api-schemas';

/** REST response shapes (OpenAPI), mirroring ValuationsService's views. Share holdings only, not cash. */
const priceStatus = z.enum(['CLOSE', 'NON_TRADING_DAY', 'PRICE_PENDING', 'MISSING', 'CURRENCY_MISMATCH']);

export const valuationDaySchema = apiSchema(
  'ValuationDay',
  z.object({
    date: z.string(),
    complete: z.boolean(),
    includesMockPrices: z.boolean(),
    priceProvider: z.string(),
    computedAt: z.string(),
    totals: z.object({
      byCurrency: z.array(
        z.object({
          currency: z.string(),
          marketValue: decimalOut(),
          costBase: decimalOut(),
          holdings: z.number().int(),
          unvaluedHoldings: z.number().int(),
          provisionalHoldings: z.number().int(),
        }),
      ),
      converted: z.object({ baseCurrency: z.string(), marketValue: decimalOut(), costBase: decimalOut() }).nullable(),
    }),
    holdings: z
      .array(
        z.object({
          accountId: z.string(),
          symbol: z.string(),
          currency: z.string(),
          quantity: decimalOut(),
          costBase: decimalOut(),
          marketValue: decimalOut().nullable(),
          price: z.object({
            status: priceStatus,
            close: decimalOut().nullable(),
            currency: z.string().nullable(),
            tradingDate: z.string().nullable(),
            closeTime: z.string().nullable(),
            exchangeTimezone: z.string().nullable(),
            source: z.string().nullable(),
            isMock: z.boolean().nullable(),
            note: z.string().nullable(),
          }),
          lots: z.array(z.object({ lotId: z.string(), acquiredOn: z.string(), quantity: decimalOut(), costBase: decimalOut(), marketValue: decimalOut().nullable() })),
        }),
      )
      .optional(),
  }),
);

export const valuationHistoryResultSchema = apiSchema(
  'ValuationHistory',
  z.object({
    fromDate: z.string(),
    toDate: z.string(),
    accountId: z.string().nullable(),
    includeSubaccounts: z.boolean(),
    symbol: z.string().nullable(),
    fx: z.object({ baseCurrency: z.string(), rates: z.record(z.string(), z.string()), policy: z.string() }).nullable(),
    days: z.array(valuationDaySchema),
    notes: z.array(z.string()),
  }),
);

export const valuationStatusSchema = apiSchema(
  'ValuationStatus',
  z.object({
    priceProvider: z.string(),
    priceProviderIsMock: z.boolean(),
    jobEnabled: z.boolean(),
    intervalMinutes: z.number(),
    settledThrough: z.string(),
    earliestValuationDate: z.string().nullable(),
    latestValuationDate: z.string().nullable(),
    materialisedDays: z.number().int(),
    partialDays: z.number().int(),
    pendingRecomputeFrom: z.string().nullable(),
    lastRun: z.object({ startedAt: z.string().nullable(), finishedAt: z.string().nullable(), status: z.string().nullable() }).nullable(),
  }),
);

export const recomputeResultSchema = apiSchema(
  'ValuationRecomputeResult',
  z.object({ requested: z.boolean(), fromDate: z.string(), accounts: z.number().int(), note: z.string() }),
);
