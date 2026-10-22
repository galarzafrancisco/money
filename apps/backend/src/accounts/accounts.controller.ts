import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ApiRoute } from '../openapi/api-route.decorator';
import { apiSchema } from '../openapi/api-schemas';
import type { CurrentUser } from '../users/users.service';
import { UnifiedAccountsService, listUnifiedAccountsShape } from './unified-accounts.service';
import { accountSchema, deleteAccountResultSchema, unifiedAccountListSchema, unifiedAccountSchema } from './accounts.responses';
import { createAccountSchema, updateAccountSchema } from './accounts.schemas';
import { AccountsService } from './accounts.service';

const deleteAccountQuery = z.object({
  deleteTransactions: z.enum(['true', 'false']).optional().describe('Must be "true" to delete an account that still has transactions'),
});

@Controller('api/accounts')
@Protected()
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly allAccounts: UnifiedAccountsService,
  ) {}

  @Get()
  @ApiRoute({ tag: 'accounts', operationId: 'listAccounts', summary: 'List your accounts, including subaccounts and accounts imported from Up (hidden ones too; see source and visible)', query: z.object(listUnifiedAccountsShape), response: unifiedAccountListSchema })
  list(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, string>) {
    return this.allAccounts.list(user, query);
  }

  @Post()
  @ApiRoute({ tag: 'accounts', operationId: 'createAccount', summary: 'Create an account or subaccount', body: apiSchema('CreateAccountRequest', createAccountSchema), response: accountSchema })
  create(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.accounts.create(user, body as never);
  }

  @Get(':accountId')
  @ApiRoute({ tag: 'accounts', operationId: 'getAccount', summary: 'Get one account, manual or imported from Up', response: unifiedAccountSchema })
  get(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string) {
    return this.allAccounts.get(user, accountId);
  }

  @Patch(':accountId')
  @ApiRoute({ tag: 'accounts', operationId: 'updateAccount', summary: 'Rename, move or recategorise an account', body: apiSchema('UpdateAccountRequest', updateAccountSchema), response: accountSchema })
  update(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Body() body: unknown) {
    return this.accounts.update(user, accountId, body as never);
  }

  @Delete(':accountId')
  @HttpCode(200)
  @ApiRoute({ tag: 'accounts', operationId: 'deleteAccount', summary: 'Delete an account', query: deleteAccountQuery, response: deleteAccountResultSchema })
  delete(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Query('deleteTransactions') deleteTransactions?: string) {
    return this.accounts.delete(user, accountId, { deleteTransactions: deleteTransactions === 'true' });
  }
}
