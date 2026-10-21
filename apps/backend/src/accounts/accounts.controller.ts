import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import type { CurrentUser } from '../users/users.service';
import { AccountsService } from './accounts.service';

@Controller('api/accounts')
@Protected()
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list(@AuthenticatedUser() user: CurrentUser) {
    return this.accounts.list(user);
  }

  @Post()
  create(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.accounts.create(user, body as never);
  }

  @Get(':accountId')
  get(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string) {
    return this.accounts.get(user, accountId);
  }

  @Patch(':accountId')
  update(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Body() body: unknown) {
    return this.accounts.update(user, accountId, body as never);
  }

  @Delete(':accountId')
  @HttpCode(200)
  delete(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Query('deleteTransactions') deleteTransactions?: string) {
    return this.accounts.delete(user, accountId, { deleteTransactions: deleteTransactions === 'true' });
  }
}
