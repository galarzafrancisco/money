import { z } from 'zod';
import { apiSchema, decimalOut } from '../openapi/api-schemas';

/** REST response shapes (OpenAPI), mirroring ValuationsService's views. Share holdings only, not cash. */
const priceStatus = z.enum(['CLOSE', 'NON_TRADING_DAY', 'PRICE_PENDING', 'MISSING', 'CURRENCY_MISMATCH']);

const fxRateUsed = z.object({
  currency: z.string(),
  rate: decimalOut('Units of baseCurrency per unit of currency'),
  kind: z.enum(['HISTORICAL', 'CONSTANT']),
  tradingDate: z.string().nullable().describe('HISTORICAL: the date of the FX close used (the latest on or before the valuation date)'),
  source: z.string(),
  isMock: z.boolean(),
});

const fxView = z
  .object({
    baseCurrency: z.string(),
    policy: z.enum(['HISTORICAL', 'CONSTANT']),
    rates: z.record(z.string(), z.string()).nullable().describe('CONSTANT only: your rates'),
    description: z.string(),
  })
  .nullable();

const dayFields = {
  date: z.string(),
  complete: z.boolean(),
  includesMockPrices: z.boolean(),
  pendingRecompute: z.boolean().describe('A backdated change or price correction is waiting to be re-valued on this date; figures may change'),
  priceProvider: z.string(),
  computedAt: z.string(),
};

const holdingSchema = z.object({
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
});

export const valuationDaySchema = apiSchema(
  'ValuationDay',
  z.object({
    ...dayFields,
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
      converted: z
        .object({ baseCurrency: z.string(), marketValue: decimalOut(), costBase: decimalOut(), rates: z.array(fxRateUsed) })
        .nullable()
        .describe('Null without baseCurrency, or when a currency has no rate for this date (see conversionUnavailable)'),
      conversionUnavailable: z.array(z.object({ currency: z.string(), reason: z.string() })),
    }),
    holdings: z.array(holdingSchema).optional(),
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
    fx: fxView,
    days: z.array(valuationDaySchema),
    notes: z.array(z.string()),
  }),
);

export const valuationAsOfResultSchema = apiSchema(
  'ValuationAsOf',
  z.object({
    ...dayFields,
    basis: z.enum(['SNAPSHOT', 'ON_DEMAND']).describe('SNAPSHOT: the materialised valuation. ON_DEMAND: reconstructed now from the ledger and stored closes.'),
    basisReason: z.string(),
    accountId: z.string().nullable(),
    includeSubaccounts: z.boolean(),
    symbol: z.string().nullable(),
    fx: fxView,
    totals: valuationDaySchema.shape.totals,
    holdings: z.array(holdingSchema),
    warnings: z.array(z.string()),
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
  z.object({
    requested: z.boolean(),
    fromDate: z.string(),
    accounts: z.number().int(),
    refreshedSymbols: z.array(z.string()).describe('Symbols whose closes from fromDate are fetched again (refreshPrices)'),
    note: z.string(),
  }),
);
