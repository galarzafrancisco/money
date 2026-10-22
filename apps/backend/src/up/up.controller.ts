import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ApiRoute } from '../openapi/api-route.decorator';
import { apiSchema } from '../openapi/api-schemas';
import type { CurrentUser } from '../users/users.service';
import {
  disconnectUpResultSchema,
  upAccountListSchema,
  upAccountSchema,
  upStatusSchema,
  upSyncResultSchema,
  upSyncRunListSchema,
  upTransactionPageSchema,
  upTransactionSchema,
} from './up.responses';
import {
  connectUpSchema,
  disconnectUpSchema,
  listUpAccountsSchema,
  listUpTransactionsSchema,
  matchUpTransactionSchema,
  setUpVisibilitySchema,
  updateUpAccountSchema,
} from './up.schemas';
import { UpService } from './up.service';

/**
 * Management and read API for the read-only Up! import. Authenticated like the
 * rest of /api (Taico bearer token, or the web session cookie with CSRF).
 * Frontend contract: apps/backend/docs/up-integration.md.
 */
@Controller('api/up')
@Protected()
export class UpController {
  constructor(private readonly up: UpService) {}

  @Get('status')
  @ApiRoute({ tag: 'up', operationId: 'getUpStatus', summary: 'Whether Up is connected, its sync state and how many accounts are shown or hidden', response: upStatusSchema })
  status(@AuthenticatedUser() user: CurrentUser) {
    return this.up.status(user);
  }

  /** Body: { token }. The token is used read-only, stored encrypted and never returned. Imports all accounts and transactions before answering. */
  @Post('connection')
  @ApiRoute({
    tag: 'up',
    operationId: 'connectUp',
    summary: 'Connect (or reconnect with a new token) Up with a personal access token and import your accounts and transactions',
    body: apiSchema('ConnectUpRequest', connectUpSchema),
    response: upStatusSchema,
  })
  connect(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.up.connect(user, body as never);
  }

  /** Query: purge (true also deletes everything imported from Up) */
  @Delete('connection')
  @HttpCode(200)
  @ApiRoute({
    tag: 'up',
    operationId: 'disconnectUp',
    summary: 'Disconnect Up: erase the stored token and stop syncing. Imported data is kept unless purge is true',
    query: disconnectUpQuery(),
    response: disconnectUpResultSchema,
  })
  disconnect(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, string>) {
    return this.up.disconnect(user, { purge: query.purge === undefined ? undefined : query.purge === 'true' });
  }

  @Post('sync')
  @HttpCode(200)
  @ApiRoute({ tag: 'up', operationId: 'syncUp', summary: 'Re-read your accounts and recent transactions from Up now', response: upSyncResultSchema })
  async sync(@AuthenticatedUser() user: CurrentUser) {
    const result = await this.up.syncNow(user);
    return { accounts: result.accounts, transactionsCreated: result.created, transactionsUpdated: result.updated, transactionsDeleted: result.deleted, status: result.status };
  }

  @Get('sync-runs')
  @ApiRoute({ tag: 'up', operationId: 'listUpSyncRuns', summary: 'The last 20 syncs, newest first (audit trail)', response: upSyncRunListSchema })
  runs(@AuthenticatedUser() user: CurrentUser) {
    return this.up.runs(user);
  }

  /** Query: visibility = visible (default) | hidden | all */
  @Get('accounts')
  @ApiRoute({ tag: 'up', operationId: 'listUpAccounts', summary: 'List imported Up accounts. Hidden ones need visibility=hidden or all', query: listUpAccountsSchema, response: upAccountListSchema })
  accounts(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, string>) {
    return this.up.listAccounts(user, query);
  }

  @Put('accounts/visibility')
  @ApiRoute({
    tag: 'up',
    operationId: 'setUpAccountVisibility',
    summary: 'Choose which Up accounts are shown; every other imported account becomes hidden (still imported and tracked)',
    body: apiSchema('SetUpVisibilityRequest', setUpVisibilitySchema),
    response: upAccountListSchema,
  })
  setVisibility(@AuthenticatedUser() user: CurrentUser, @Body() body: unknown) {
    return this.up.setVisibility(user, body as never);
  }

  @Patch('accounts/:accountId')
  @ApiRoute({ tag: 'up', operationId: 'updateUpAccount', summary: 'Show or hide one Up account, or map it to a Money account', body: apiSchema('UpdateUpAccountRequest', updateUpAccountSchema), response: upAccountSchema })
  updateAccount(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Body() body: unknown) {
    return this.up.updateAccount(user, accountId, body);
  }

  /** Query: accountId, visibility, status, fromDate, toDate, includeDeleted, reconciliation, limit, offset */
  @Get('transactions')
  @ApiRoute({ tag: 'up', operationId: 'listUpTransactions', summary: 'List imported Up transactions (visible accounts by default; accountId or visibility=all for hidden ones)', query: listUpTransactionsSchema, response: upTransactionPageSchema })
  transactions(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, string>) {
    return this.up.listTransactions(user, query);
  }

  @Put('transactions/:transactionId/match')
  @ApiRoute({ tag: 'up', operationId: 'matchUpTransaction', summary: 'Mark an imported transaction as the same event as one you recorded manually, so it is not counted twice', body: apiSchema('MatchUpTransactionRequest', matchUpTransactionSchema), response: upTransactionSchema })
  match(@AuthenticatedUser() user: CurrentUser, @Param('transactionId') transactionId: string, @Body() body: unknown) {
    return this.up.match(user, transactionId, body);
  }

  @Delete('transactions/:transactionId/match')
  @HttpCode(200)
  @ApiRoute({ tag: 'up', operationId: 'unmatchUpTransaction', summary: 'Remove the link between an imported transaction and a manual one', response: upTransactionSchema })
  unmatch(@AuthenticatedUser() user: CurrentUser, @Param('transactionId') transactionId: string) {
    return this.up.unmatch(user, transactionId);
  }
}

function disconnectUpQuery() {
  return disconnectUpSchema.extend({ purge: disconnectUpSchema.shape.purge.unwrap().or(disconnectUpSchema.shape.purge) });
}
