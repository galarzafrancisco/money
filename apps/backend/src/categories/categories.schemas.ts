import { z } from 'zod';
import { tickerSymbol } from '../common/validation';

const color = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour, e.g. "#4f9d69"')
  .describe('Optional #rrggbb colour for dashboards');

/** Shared by REST bodies and MCP tool inputs */
export const createCategorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe('Your own label for how you think about money, unique per user (case-insensitive), e.g. "alpha-high-risk", "boring-etf" or "emergency"'),
  description: z.string().trim().max(2000).nullish().describe('Optional notes about what belongs in this category'),
  color: color.nullish(),
});
export type CreateCategoryInput = z.input<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional().describe('New name, unique per user (case-insensitive)'),
    description: z.string().trim().max(2000).nullish().describe('Notes; null clears them'),
    color: color.nullish().describe('#rrggbb colour; null clears it'),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'Provide at least one field to change' });
export type UpdateCategoryInput = z.input<typeof updateCategorySchema>;

export const deleteCategorySchema = z.object({
  unassign: z
    .boolean()
    .optional()
    .default(false)
    .describe('Required when the category is assigned. Clears its assignments; those accounts and holdings then inherit their category again.'),
});

export const holdingCategorySchema = z.object({
  symbol: tickerSymbol,
  categoryId: z
    .string()
    .nullable()
    .describe('Category ID (from list_categories), or null to clear the holding\'s own category so it inherits the account\'s'),
});
export type HoldingCategoryInput = z.input<typeof holdingCategorySchema>;
