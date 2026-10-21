import { z } from 'zod';
import { ValidationError } from './errors';
import { DECIMAL_PATTERN } from './decimal';

/** Parses input with a schema and turns zod issues into a ValidationError */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
    throw new ValidationError(`Invalid input: ${summary}`, { issues });
  }
  return result.data;
}

/** A decimal amount as a string, e.g. "1234.56". Numbers are accepted and converted, to be lenient with MCP clients. */
export const decimalString = (description: string) =>
  z
    .union([z.string(), z.number()])
    .transform((value) => (typeof value === 'number' ? String(value) : value.trim()))
    .refine((value) => DECIMAL_PATTERN.test(value), {
      message: 'must be a decimal number, e.g. "1234.56"',
    })
    .refine((value) => (value.split('.')[1]?.length ?? 0) <= 10, {
      message: 'must have at most 10 decimal places',
    })
    .describe(description);

export const currencyCode = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value), { message: 'must be a 3-letter ISO 4217 code, e.g. AUD' })
  .describe('ISO 4217 currency code, e.g. AUD or USD');

export const isoDate = z
  .string()
  .trim()
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), {
    message: 'must be a calendar date YYYY-MM-DD',
  })
  .describe('Date the activity happened (YYYY-MM-DD), as shown on the statement');

export const tickerSymbol = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z0-9][A-Z0-9.\-^=]{0,31}$/.test(value), {
    message: 'must be a ticker such as VOO or VAS.AX',
  })
  .describe('Ticker symbol. Use the exchange suffix for non-US listings, e.g. VAS.AX for the ASX');

export const uuid = z.string().uuid();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** IDs are checked before they reach a query, so a malformed one is simply "not found" */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
