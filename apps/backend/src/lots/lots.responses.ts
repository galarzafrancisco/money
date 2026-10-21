import { z } from 'zod';
import { apiSchema, decimalOut } from '../openapi/api-schemas';

const selection = z.enum(['FIFO', 'SPECIFIC']);

/** REST response shapes (OpenAPI), mirroring LotsService's LotsView and SaleAllocationsView */
export const lotSchema = apiSchema(
  'Lot',
  z.object({
    lotId: z.string().describe('The ID of the BUY this lot came from'),
    buyTransactionId: z.string(),
    accountId: z.string(),
    symbol: z.string(),
    currency: z.string(),
    acquiredOn: z.string(),
    sequence: z.number().int().describe('With acquiredOn, the FIFO position'),
    status: z.enum(['OPEN', 'CLOSED']),
    originalQuantity: decimalOut(),
    originalCostBase: decimalOut(),
    unitCostBase: decimalOut(),
    remainingQuantity: decimalOut(),
    remainingCostBase: decimalOut(),
    daysHeld: z.number().int(),
    heldOverTwelveMonths: z.boolean(),
    disposals: z.array(
      z.object({ saleTransactionId: z.string(), disposedOn: z.string(), selection, quantity: decimalOut(), costBase: decimalOut() }),
    ),
  }),
);

export const lotsResultSchema = apiSchema(
  'LotList',
  z.object({
    accountId: z.string(),
    asOf: z.string().nullable(),
    symbol: z.string().nullable(),
    excludedTransactionId: z.string().nullable(),
    lots: z.array(lotSchema),
    notes: z.array(z.string()),
  }),
);

export const saleAllocationsSchema = apiSchema(
  'SaleAllocations',
  z.object({
    saleTransactionId: z.string(),
    accountId: z.string(),
    symbol: z.string(),
    currency: z.string(),
    date: z.string(),
    lotSelection: selection,
    quantity: decimalOut(),
    unitPrice: decimalOut(),
    fees: decimalOut(),
    total: decimalOut(),
    allocations: z.array(
      z.object({
        lotId: z.string(),
        acquiredOn: z.string(),
        quantity: decimalOut(),
        unitCostBase: decimalOut(),
        costBase: decimalOut(),
        grossProceeds: decimalOut(),
        fees: decimalOut(),
        proceeds: decimalOut(),
        gain: decimalOut(),
        daysHeld: z.number().int(),
        heldOverTwelveMonths: z.boolean(),
      }),
    ),
    totals: z.object({
      quantity: decimalOut(),
      costBase: decimalOut(),
      grossProceeds: decimalOut(),
      fees: decimalOut(),
      proceeds: decimalOut(),
      gain: decimalOut(),
    }),
    notes: z.array(z.string()),
  }),
);
