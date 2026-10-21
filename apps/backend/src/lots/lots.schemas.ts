import { z } from 'zod';
import { isoDate, tickerSymbol } from '../common/validation';

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
  .describe('true or false');

/** Shared by GET /api/accounts/:id/lots and the list_lots tool */
export const listLotsSchema = z
  .object({
    symbol: tickerSymbol.optional().describe('Only lots of this ticker'),
    asOf: isoDate
      .optional()
      .describe('Lots as they stood at the end of this date, i.e. what a sale dated asOf could use (YYYY-MM-DD). Default: after every recorded transaction.'),
    excludeTransactionId: z
      .string()
      .optional()
      .describe('Leave this sale out, e.g. the sale being edited, so the shares it took show as available again'),
    includeClosed: booleanish.default(false).describe('Also list fully sold lots (default false)'),
  })
  .strict();

export type ListLotsInput = z.input<typeof listLotsSchema>;
