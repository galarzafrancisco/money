import { z } from 'zod';
import { currencyCode, decimalString, isoDate, tickerSymbol } from '../common/validation';
import { TRANSACTION_TYPES } from '../ledger/ledger.types';

/**
 * Input schemas for recording transactions. The same schemas validate REST
 * bodies (as a union on `type`) and the arguments of the MCP record_* tools.
 */
const common = {
  date: isoDate,
  description: z.string().trim().max(2000).nullish().describe('Optional note, e.g. the broker reference'),
};

const external = {
  externalCurrency: currencyCode.optional().describe('Currency on the other side, outside the account (e.g. AUD that left the bank for a USD deposit). Informational.'),
  externalAmount: decimalString('Amount on the other side, in externalCurrency. Informational; it does not change balances.').optional(),
};

const bothOrNeither = (value: { externalCurrency?: string; externalAmount?: string }) =>
  (value.externalCurrency === undefined) === (value.externalAmount === undefined);
const bothOrNeitherMessage = { message: 'externalCurrency and externalAmount go together', path: ['externalAmount'] };

export const depositShape = {
  ...common,
  currency: currencyCode.describe('Currency credited to the account'),
  amount: decimalString('Amount credited to the account, e.g. "5000.00"'),
  ...external,
};
export const withdrawalShape = {
  ...common,
  currency: currencyCode.describe('Currency debited from the account'),
  amount: decimalString('Amount debited from the account'),
  ...external,
};
export const fxShape = {
  ...common,
  fromCurrency: currencyCode.describe('Currency sold'),
  toCurrency: currencyCode.describe('Currency bought'),
  fromAmount: decimalString('Amount of fromCurrency sold (excluding fees)').optional(),
  toAmount: decimalString('Amount of toCurrency received').optional(),
  rate: decimalString('Units of toCurrency per unit of fromCurrency, e.g. 0.65 for AUD→USD').optional(),
  fees: decimalString('Conversion fee charged in fromCurrency, on top of fromAmount. Default 0.').optional(),
};
export const tradeShape = {
  ...common,
  symbol: tickerSymbol,
  currency: currencyCode.describe('Currency the shares trade and settle in'),
  quantity: decimalString('Number of shares; fractions allowed').optional(),
  unitPrice: decimalString('Price per share').optional(),
  fees: decimalString('Brokerage and other fees').optional(),
  total: decimalString('Buy: cash paid including fees. Sell: cash received after fees.').optional(),
};
/**
 * Specific identification for a sale: which purchase lots the shares came
 * from. lotId is the ID of the BUY transaction (see list_lots). Quantities
 * must be positive and add up to the sale's quantity; each lot at most once.
 */
export const lotAllocationsSchema = z
  .array(
    z
      .object({
        lotId: z.string().uuid().describe('Lot ID: the ID of the BUY transaction (from list_lots / GET /api/accounts/:id/lots)'),
        quantity: decimalString('Shares taken from this lot; fractions allowed'),
      })
      .strict(),
  )
  .min(1, { message: 'name at least one lot, or leave allocations out for FIFO' })
  .max(1000)
  .superRefine((allocations, ctx) => {
    const seen = new Set<string>();
    allocations.forEach((allocation, index) => {
      if (!/[1-9]/.test(allocation.quantity) || allocation.quantity.startsWith('-')) {
        ctx.addIssue({ code: 'custom', message: 'quantity must be greater than zero', path: [index, 'quantity'] });
      }
      const key = allocation.lotId.toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `lot ${allocation.lotId} is allocated more than once`, path: [index, 'lotId'] });
      seen.add(key);
    });
  })
  .describe(
    'Specific identification: the purchase lots this sale came from and how many shares from each, e.g. [{"lotId":"<buy id>","quantity":"15"},{"lotId":"<other buy id>","quantity":"25"}]. Must add up to the sale quantity. Leave out to match lots FIFO.',
  );
export type LotAllocationsInput = z.infer<typeof lotAllocationsSchema>;

export const sellShape = {
  ...tradeShape,
  allocations: lotAllocationsSchema.optional(),
};

export const dividendShape = {
  ...common,
  symbol: tickerSymbol,
  currency: currencyCode.describe('Currency the dividend was paid in'),
  grossAmount: decimalString('Dividend before tax withheld').optional(),
  withholdingTax: decimalString('Tax withheld at source, e.g. US withholding. Use "0" if none.').optional(),
  netAmount: decimalString('Cash actually received (gross − withholding)').optional(),
  frankingCredits: decimalString('Australian franking credits attached (not cash). Default 0.').optional(),
};

export const depositSchema = z.object(depositShape).refine(bothOrNeither, bothOrNeitherMessage);
export const withdrawalSchema = z.object(withdrawalShape).refine(bothOrNeither, bothOrNeitherMessage);
export const fxSchema = z
  .object(fxShape)
  .refine((v) => v.fromCurrency !== v.toCurrency, { message: 'fromCurrency and toCurrency must differ', path: ['toCurrency'] });
export const tradeSchema = z.object(tradeShape);
export const sellSchema = z.object(sellShape);
export const dividendSchema = z.object(dividendShape);

export const recordTransactionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('DEPOSIT'), ...depositShape }).refine(bothOrNeither, bothOrNeitherMessage),
  z.object({ type: z.literal('WITHDRAWAL'), ...withdrawalShape }).refine(bothOrNeither, bothOrNeitherMessage),
  z.object({ type: z.literal('FX_CONVERSION'), ...fxShape }),
  z.object({ type: z.literal('BUY'), ...tradeShape }),
  z.object({ type: z.literal('SELL'), ...sellShape }),
  z.object({ type: z.literal('DIVIDEND'), ...dividendShape }),
]);
export type RecordTransactionInput = z.input<typeof recordTransactionSchema>;

/**
 * An edit. Only fields that apply to the transaction's type are accepted.
 * Setting a calculable field (e.g. total, fees, rate, netAmount) to null asks
 * Money to recalculate it from the others.
 */
const nullableDecimal = (description: string) => decimalString(description).nullable().optional();
export const updateTransactionSchema = z
  .object({
    date: isoDate.optional(),
    description: z.string().trim().max(2000).nullish(),
    currency: currencyCode.optional(),
    amount: decimalString('Deposit or withdrawal amount').optional(),
    externalCurrency: currencyCode.nullable().optional(),
    externalAmount: nullableDecimal('Other-side amount; null clears it'),
    fromCurrency: currencyCode.optional(),
    toCurrency: currencyCode.optional(),
    fromAmount: nullableDecimal('FX amount sold; null recalculates it'),
    toAmount: nullableDecimal('FX amount bought; null recalculates it'),
    rate: nullableDecimal('FX rate; null recalculates it'),
    symbol: tickerSymbol.optional(),
    quantity: nullableDecimal('Shares; null recalculates it'),
    unitPrice: nullableDecimal('Price per share; null recalculates it'),
    fees: nullableDecimal('Fees; null recalculates them (trades) or sets 0 (FX)'),
    total: nullableDecimal('Trade total; null recalculates it'),
    grossAmount: nullableDecimal('Dividend gross; null recalculates it'),
    withholdingTax: nullableDecimal('Dividend withholding; null recalculates it'),
    netAmount: nullableDecimal('Dividend net; null recalculates it'),
    frankingCredits: decimalString('Franking credits').optional(),
    allocations: lotAllocationsSchema
      .nullable()
      .optional()
      .describe('SELL only. New lot allocations (replacing the old ones); null switches the sale to FIFO. Left out, they are kept and must still add up to the quantity.'),
  })
  .strict()
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'Provide at least one field to change' });
export type UpdateTransactionInput = z.input<typeof updateTransactionSchema>;

export const listTransactionsSchema = z.object({
  type: z.enum(TRANSACTION_TYPES).optional(),
  symbol: tickerSymbol.optional(),
  fromDate: isoDate.optional().describe('Only transactions on or after this date'),
  toDate: isoDate.optional().describe('Only transactions on or before this date'),
});

/** Which update fields apply to which type */
export const UPDATABLE_FIELDS: Record<string, readonly string[]> = {
  DEPOSIT: ['date', 'description', 'currency', 'amount', 'externalCurrency', 'externalAmount'],
  WITHDRAWAL: ['date', 'description', 'currency', 'amount', 'externalCurrency', 'externalAmount'],
  FX_CONVERSION: ['date', 'description', 'fromCurrency', 'toCurrency', 'fromAmount', 'toAmount', 'rate', 'fees'],
  BUY: ['date', 'description', 'symbol', 'currency', 'quantity', 'unitPrice', 'fees', 'total'],
  SELL: ['date', 'description', 'symbol', 'currency', 'quantity', 'unitPrice', 'fees', 'total', 'allocations'],
  DIVIDEND: ['date', 'description', 'symbol', 'currency', 'grossAmount', 'withholdingTax', 'netAmount', 'frankingCredits'],
};
