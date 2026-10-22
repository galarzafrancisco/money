import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ApiRoute } from '../openapi/api-route.decorator';
import { apiSchema } from '../openapi/api-schemas';
import { reportOptionsSchema } from '../reports/reports.schemas';
import type { CurrentUser } from '../users/users.service';
import { accountGroupSchema, accountGroupsViewSchema, deleteAccountGroupResultSchema } from './account-groups.responses';
import { createAccountGroupSchema, updateAccountGroupSchema } from './account-groups.schemas';
import { AccountGroupsService } from './account-groups.service';

/** Same valuation and FX options as the reports, without rootAccountId */
export const groupViewOptionsSchema = z.object({
  valuation: reportOptionsSchema.shape.valuation,
  baseCurrency: reportOptionsSchema.shape.baseCurrency,
  fxRates: reportOptionsSchema.shape.fxRates,
});

/** Logical account groups: docs/account-groups.md */
@Controller('api/account-groups')
@Protected()
export class AccountGroupsController {
  constructor(private readonly groups: AccountGroupsService) {}

  @Get()
  @ApiRoute({
    tag: 'account-groups',
    operationId: 'listAccountGroups',
    summary: 'Your logical account groups with member accounts and totals, plus the physical accounts in no group',
    query: groupViewOptionsSchema,
    response: accountGroupsViewSchema,
  })
  list(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, unknown>) {
    return this.groups.list(user, query as never);
  }

  @Post()
  @ApiRoute({ tag: 'account-groups', operationId: 'createAccountGroup', summary: 'Create a group, optionally with its member accounts', body: apiSchema('CreateAccountGroupRequest', createAccountGroupSchema), response: accountGroupSchema })
  create(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.groups.create(user, body as never);
  }

  @Get(':groupId')
  @ApiRoute({ tag: 'account-groups', operationId: 'getAccountGroup', summary: 'Get one group with its members and totals', query: groupViewOptionsSchema, response: accountGroupSchema })
  get(@AuthenticatedUser() user: CurrentUser, @Param('groupId') groupId: string, @Query() query: Record<string, unknown>) {
    return this.groups.get(user, groupId, query as never);
  }

  @Patch(':groupId')
  @ApiRoute({
    tag: 'account-groups',
    operationId: 'updateAccountGroup',
    summary: 'Rename a group, edit its notes, or replace its member accounts',
    body: apiSchema('UpdateAccountGroupRequest', updateAccountGroupSchema),
    response: accountGroupSchema,
  })
  update(@AuthenticatedUser() user: CurrentUser, @Param('groupId') groupId: string, @Body() body: unknown) {
    return this.groups.update(user, groupId, body as never);
  }

  @Delete(':groupId')
  @HttpCode(200)
  @ApiRoute({ tag: 'account-groups', operationId: 'deleteAccountGroup', summary: 'Delete a group. Its accounts are released, not deleted.', response: deleteAccountGroupResultSchema })
  delete(@AuthenticatedUser() user: CurrentUser, @Param('groupId') groupId: string) {
    return this.groups.delete(user, groupId);
  }
}
