import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ApiRoute } from '../openapi/api-route.decorator';
import { apiSchema } from '../openapi/api-schemas';
import type { CurrentUser } from '../users/users.service';
import {
  categoryListSchema,
  categorySchema,
  categoryWithUsageSchema,
  deleteCategoryResultSchema,
  holdingCategoryListSchema,
  holdingCategoryResultSchema,
} from './categories.responses';
import { createCategorySchema, holdingCategorySchema, updateCategorySchema } from './categories.schemas';
import { CategoriesService } from './categories.service';

const deleteCategoryQuery = z.object({
  unassign: z.enum(['true', 'false']).optional().describe('"true" is required when the category is assigned; it clears those assignments'),
});
const holdingCategoriesQuery = z.object({ accountId: z.string().optional().describe('Only holdings in this account') });
const setHoldingCategoryBody = apiSchema('SetHoldingCategoryRequest', holdingCategorySchema.pick({ categoryId: true }));

@Controller('api')
@Protected()
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get('categories')
  @ApiRoute({ tag: 'categories', operationId: 'listCategories', summary: 'List your categories', response: categoryListSchema })
  list(@AuthenticatedUser() user: CurrentUser) {
    return this.categories.list(user);
  }

  @Post('categories')
  @ApiRoute({ tag: 'categories', operationId: 'createCategory', summary: 'Create a category', body: apiSchema('CreateCategoryRequest', createCategorySchema), response: categorySchema })
  create(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.categories.create(user, body as never);
  }

  @Get('categories/:categoryId')
  @ApiRoute({ tag: 'categories', operationId: 'getCategory', summary: 'Get a category and how many accounts and holdings use it', response: categoryWithUsageSchema })
  get(@AuthenticatedUser() user: CurrentUser, @Param('categoryId') categoryId: string) {
    return this.categories.get(user, categoryId);
  }

  @Patch('categories/:categoryId')
  @ApiRoute({ tag: 'categories', operationId: 'updateCategory', summary: 'Edit a category', body: apiSchema('UpdateCategoryRequest', updateCategorySchema), response: categorySchema })
  update(@AuthenticatedUser() user: CurrentUser, @Param('categoryId') categoryId: string, @Body() body: unknown) {
    return this.categories.update(user, categoryId, body as never);
  }

  @Delete('categories/:categoryId')
  @HttpCode(200)
  @ApiRoute({ tag: 'categories', operationId: 'deleteCategory', summary: 'Delete a category', query: deleteCategoryQuery, response: deleteCategoryResultSchema })
  delete(@AuthenticatedUser() user: CurrentUser, @Param('categoryId') categoryId: string, @Query('unassign') unassign?: string) {
    return this.categories.delete(user, categoryId, { unassign: unassign === 'true' });
  }

  /** Holdings that have a category of their own. ?accountId= limits it to one account. */
  @Get('holding-categories')
  @ApiRoute({ tag: 'categories', operationId: 'listHoldingCategories', summary: 'Holdings that have a category of their own', query: holdingCategoriesQuery, response: holdingCategoryListSchema })
  listHoldingCategories(@AuthenticatedUser() user: CurrentUser, @Query('accountId') accountId?: string) {
    return this.categories.listHoldingCategories(user, accountId);
  }

  /** Body: { categoryId } (null clears it) */
  @Put('accounts/:accountId/holdings/:symbol/category')
  @ApiRoute({ tag: 'categories', operationId: 'setHoldingCategory', summary: "Set (or, with null, clear) a holding's own category", body: setHoldingCategoryBody, response: holdingCategoryResultSchema })
  setHoldingCategory(
    @AuthenticatedUser() user: CurrentUser,
    @Param('accountId') accountId: string,
    @Param('symbol') symbol: string,
    @Body() body: { categoryId?: unknown } | undefined,
  ) {
    return this.categories.setHoldingCategory(user, accountId, { symbol, categoryId: (body?.categoryId ?? undefined) as never });
  }

  @Delete('accounts/:accountId/holdings/:symbol/category')
  @HttpCode(200)
  @ApiRoute({ tag: 'categories', operationId: 'clearHoldingCategory', summary: "Clear a holding's own category so it inherits the account's", response: holdingCategoryResultSchema })
  clearHoldingCategory(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Param('symbol') symbol: string) {
    return this.categories.setHoldingCategory(user, accountId, { symbol, categoryId: null });
  }
}
