import { z } from 'zod';
import { accountSchema } from '../accounts/accounts.responses';
import { apiSchema, decimalOut } from '../openapi/api-schemas';

/** REST response shapes (OpenAPI), mirroring PortfolioView and the user and quote views */
const dividendTotals = {
  currency: z.string(),
  grossAmount: decimalOut(),
  withholdingTax: decimalOut(),
  netAmount: decimalOut(),
  frankingCredits: decimalOut(),
};

export const holdingSchema = apiSchema(
  'Holding',
  z.object({
    symbol: z.string(),
    currency: z.string(),
    quantity: decimalOut(),
    costBase: decimalOut(),
    averageUnitCost: decimalOut(),
    price: z
      .object({ price: decimalOut(), currency: z.string(), asOf: z.string(), source: z.string(), isMock: z.boolean(), isStale: z.boolean().describe('The provider failed; this is the last known price (see asOf)') })
      .nullable()
      .describe('Latest price and its provenance; isMock prices are made up, isStale prices are the last known ones'),
    priceError: z.string().nullable(),
    marketValue: decimalOut().nullable(),
    unrealizedGain: decimalOut().nullable(),
    unrealizedGainPercent: decimalOut().nullable(),
    lots: z.array(
      z.object({
        lotId: z.string(),
        acquiredOn: z.string(),
        originalQuantity: decimalOut(),
        remainingQuantity: decimalOut(),
        costBase: decimalOut(),
        unitCostBase: decimalOut(),
        marketValue: decimalOut().nullable(),
        unrealizedGain: decimalOut().nullable(),
        heldOverTwelveMonths: z.boolean(),
      }),
    ),
  }),
);

export const portfolioSchema = apiSchema(
  'Portfolio',
  z.object({
    account: accountSchema,
    asOf: z.string(),
    priceProvider: z.string(),
    cash: z.array(z.object({ currency: z.string(), balance: decimalOut() })),
    holdings: z.array(holdingSchema),
    realized: z.object({
      totals: z.array(z.object({ currency: z.string(), proceeds: decimalOut(), costBase: decimalOut(), gain: decimalOut() })),
      disposals: z.array(
        z.object({
          sellTransactionId: z.string(),
          lotId: z.string(),
          symbol: z.string(),
          currency: z.string(),
          acquiredOn: z.string(),
          disposedOn: z.string(),
          selection: z.enum(['FIFO', 'SPECIFIC']),
          quantity: decimalOut(),
          costBase: decimalOut(),
          grossProceeds: decimalOut(),
          fees: decimalOut(),
          proceeds: decimalOut(),
          gain: decimalOut(),
          daysHeld: z.number().int(),
          heldOverTwelveMonths: z.boolean(),
        }),
      ),
    }),
    dividends: z.object({
      totals: z.array(z.object(dividendTotals)),
      bySymbol: z.array(z.object({ symbol: z.string(), ...dividendTotals })),
    }),
    notes: z.array(z.string()),
  }),
);

export const currentUserSchema = apiSchema(
  'CurrentUser',
  z.object({ id: z.string(), issuer: z.string(), subject: z.string(), displayName: z.string().nullable(), email: z.string().nullable() }),
);

export const quoteSchema = apiSchema(
  'Quote',
  z.object({
    symbol: z.string(),
    price: decimalOut(),
    currency: z.string(),
    asOf: z.string().describe('When the price is from (ISO 8601); a stale price can be days old'),
    source: z.string().describe('Provider name, e.g. yahoo or mock'),
    isMock: z.boolean().describe('Made-up development data; never rely on it'),
    priceType: z.enum(['LAST', 'CLOSE']).describe('LAST: latest regular-market price, possibly intraday and delayed. CLOSE: the close of a finished session.'),
    isStale: z.boolean().describe('The provider could not be reached; this is the last known price'),
    staleReason: z.string().nullable(),
  }),
);
