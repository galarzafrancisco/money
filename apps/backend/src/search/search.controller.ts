import { Controller, Get, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { ApiRoute } from '../openapi/api-route.decorator';
import type { CurrentUser } from '../users/users.service';
import { accountPageSchema, merchantPageSchema } from './search.responses';
import { searchAccountsSchema, searchMerchantsSchema } from './search.schemas';
import { SearchService } from './search.service';

/** Read-only name discovery over the signed-in user's own data. Contract: apps/backend/docs/search.md */
@Controller('api/search')
@Protected()
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('merchants')
  @ApiRoute({ tag: 'search', operationId: 'searchMerchants', summary: 'Find merchants in your imported Up transactions by partial name; returns a merchantKey to filter transactions with', query: searchMerchantsSchema, response: merchantPageSchema })
  merchants(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, string>) {
    return this.search.merchants(user, query);
  }

  @Get('accounts')
  @ApiRoute({ tag: 'search', operationId: 'searchAccounts', summary: 'Find accounts, manual and imported from Up, by partial name', query: searchAccountsSchema, response: accountPageSchema })
  accounts(@AuthenticatedUser() user: CurrentUser, @Query() query: Record<string, string>) {
    return this.search.accountsSearch(user, query);
  }
}
