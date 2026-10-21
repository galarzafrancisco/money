import { z } from 'zod';
import { apiSchema, decimalOut } from '../openapi/api-schemas';

/** REST response shapes (OpenAPI), mirroring TransferView */
export const transferSchema = apiSchema(
  'Transfer',
  z.object({
    id: z.string(),
    fromAccountId: z.string(),
    toAccountId: z.string(),
    date: z.string(),
    description: z.string().nullable(),
    fromCurrency: z.string(),
    fromAmount: decimalOut(),
    toCurrency: z.string(),
    toAmount: decimalOut(),
    rate: decimalOut('Units of toCurrency per unit of fromCurrency; "1" within one currency'),
    fees: decimalOut('Charged in fromCurrency to the source account, on top of fromAmount'),
    isFx: z.boolean(),
    calculatedField: z.string().nullable(),
    outTransactionId: z.string(),
    inTransactionId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export const transferListSchema = apiSchema('TransferList', z.array(transferSchema));
export const deleteTransferResultSchema = apiSchema('DeleteTransferResult', z.object({ deleted: z.boolean(), transactionsDeleted: z.number().int() }));
