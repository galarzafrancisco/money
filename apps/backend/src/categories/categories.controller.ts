import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import type { CurrentUser } from '../users/users.service';
import { CategoriesService } from './categories.service';

@Controller('api')
@Protected()
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get('categories')
  list(@AuthenticatedUser() user: CurrentUser) {
    return this.categories.list(user);
  }

  @Post('categories')
  create(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.categories.create(user, body as never);
  }

  @Get('categories/:categoryId')
  get(@AuthenticatedUser() user: CurrentUser, @Param('categoryId') categoryId: string) {
    return this.categories.get(user, categoryId);
  }

  @Patch('categories/:categoryId')
  update(@AuthenticatedUser() user: CurrentUser, @Param('categoryId') categoryId: string, @Body() body: unknown) {
    return this.categories.update(user, categoryId, body as never);
  }

  @Delete('categories/:categoryId')
  @HttpCode(200)
  delete(@AuthenticatedUser() user: CurrentUser, @Param('categoryId') categoryId: string, @Query('unassign') unassign?: string) {
    return this.categories.delete(user, categoryId, { unassign: unassign === 'true' });
  }

  /** Holdings that have a category of their own. ?accountId= limits it to one account. */
  @Get('holding-categories')
  listHoldingCategories(@AuthenticatedUser() user: CurrentUser, @Query('accountId') accountId?: string) {
    return this.categories.listHoldingCategories(user, accountId);
  }

  /** Body: { categoryId } (null clears it) */
  @Put('accounts/:accountId/holdings/:symbol/category')
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
  clearHoldingCategory(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Param('symbol') symbol: string) {
    return this.categories.setHoldingCategory(user, accountId, { symbol, categoryId: null });
  }
}
