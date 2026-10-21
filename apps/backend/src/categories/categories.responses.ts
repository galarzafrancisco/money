import { z } from 'zod';
import { apiSchema } from '../openapi/api-schemas';

/** REST response shapes (OpenAPI), mirroring CategoriesService's views */
const categoryShape = {
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
};
const usage = z.object({ accounts: z.number().int(), holdings: z.number().int() });

export const categorySchema = apiSchema('Category', z.object(categoryShape));
export const categoryListSchema = apiSchema('CategoryList', z.array(categorySchema));
export const categoryWithUsageSchema = apiSchema('CategoryWithUsage', z.object({ ...categoryShape, usage }));
export const deleteCategoryResultSchema = apiSchema('DeleteCategoryResult', z.object({ deleted: z.boolean(), unassigned: usage }));
export const holdingCategoryViewSchema = apiSchema(
  'HoldingCategory',
  z.object({ accountId: z.string(), symbol: z.string(), categoryId: z.string(), updatedAt: z.string() }),
);
export const holdingCategoryListSchema = apiSchema('HoldingCategoryList', z.array(holdingCategoryViewSchema));
export const holdingCategoryResultSchema = apiSchema(
  'HoldingCategoryResult',
  z.object({ accountId: z.string(), symbol: z.string(), categoryId: z.string().nullable() }),
);
