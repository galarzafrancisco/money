import { z } from 'zod';
import { isoDate, tickerSymbol } from '../common/validation';

/** Shared by GET /api/stock-splits and the list_stock_splits tool */
export const listSplitsSchema = z
  .object({
    symbol: tickerSymbol.optional().describe('Only this ticker (an old ticker resolves to its instrument). Omit for every recorded split.'),
    fromDate: isoDate.optional().describe('Only splits effective on or after this date (YYYY-MM-DD)'),
    toDate: isoDate.optional().describe('Only splits effective on or before this date (YYYY-MM-DD)'),
  })
  .refine((value) => !value.fromDate || !value.toDate || value.fromDate <= value.toDate, { message: 'fromDate must not be after toDate', path: ['fromDate'] });

export type ListSplitsInput = z.input<typeof listSplitsSchema>;

/** Shared by GET /api/stock-splits/adjustment and the get_split_adjustment tool */
export const splitAdjustmentSchema = z.object({
  symbol: tickerSymbol.describe('Ticker (an old ticker resolves to its instrument)'),
  date: isoDate.describe('The date (YYYY-MM-DD) whose share basis to convert from: the factor covers every split effective after it'),
});

export type SplitAdjustmentInput = z.input<typeof splitAdjustmentSchema>;
