import { z } from 'zod';
import { apiSchema, decimalOut } from '../openapi/api-schemas';

/** REST response shapes (OpenAPI), mirroring SplitsService's views */
export const stockSplitSchema = apiSchema(
  'StockSplit',
  z.object({
    instrument: z.string().describe('The canonical ticker the split belongs to'),
    effectiveDate: z.string().describe('Ex-date: the first trading date in the new share basis'),
    numerator: decimalOut(),
    denominator: decimalOut(),
    ratio: decimalOut('Shares after the split per share before it (numerator ÷ denominator)'),
    provenance: z.enum(['VERIFIED', 'PROVIDER']).describe('VERIFIED: checked and recorded by hand (wins). PROVIDER: reported by the price provider.'),
    source: z.string(),
    note: z.string().nullable(),
    symbols: z.array(z.string()).describe('The instrument and any old tickers it applies to'),
    explanation: z.string().describe('What the split does to an unchanged position on its effective date'),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export const stockSplitListSchema = apiSchema(
  'StockSplitList',
  z.object({
    symbol: z.string().nullable(),
    instrument: z.string().nullable().describe('The instrument symbol resolves to (an old ticker maps to its current one)'),
    fromDate: z.string().nullable(),
    toDate: z.string().nullable(),
    splits: z.array(stockSplitSchema),
    notes: z.array(z.string()),
  }),
);

export const splitAdjustmentResultSchema = apiSchema(
  'SplitAdjustment',
  z.object({
    symbol: z.string(),
    instrument: z.string(),
    symbols: z.array(z.string()),
    date: z.string(),
    factor: decimalOut('Cumulative factor from date\'s share basis to the present basis: present quantity = quantity on date × factor; present-basis price = price on date ÷ factor'),
    splitsAfterDate: z.array(stockSplitSchema).describe('The splits that make up factor'),
    splitsOnOrBeforeDate: z.array(stockSplitSchema).describe('Splits already reflected in date\'s basis'),
    description: z.string(),
    notes: z.array(z.string()),
  }),
);
