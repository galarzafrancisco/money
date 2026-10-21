import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { MarketPricesService } from '../market-prices/market-prices.service';
import { ApiRoute } from '../openapi/api-route.decorator';
import type { CurrentUser } from '../users/users.service';
import { currentUserSchema, portfolioSchema, quoteSchema } from './portfolio.responses';
import { PortfolioService } from './portfolio.service';

const portfolioQuery = z.object({ prices: z.enum(['true', 'false']).optional().describe('"false" skips market-price lookups') });

@Controller('api')
@Protected()
export class PortfolioController {
  constructor(
    private readonly portfolio: PortfolioService,
    private readonly prices: MarketPricesService,
  ) {}

  @Get('me')
  @ApiRoute({ tag: 'users', operationId: 'getMe', summary: 'The signed-in Money user', response: currentUserSchema })
  me(@AuthenticatedUser() user: CurrentUser) {
    return user;
  }

  /** Cash per currency, holdings with lots and valuations, realized gains and dividends. ?prices=false skips price lookups. */
  @Get('accounts/:accountId/portfolio')
  @ApiRoute({
    tag: 'portfolio',
    operationId: 'getAccountPortfolio',
    summary: "An account's cash per currency, holdings, lots, realized gains and dividends, derived from its transactions",
    query: portfolioQuery,
    response: portfolioSchema,
  })
  accountPortfolio(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Query('prices') prices?: string) {
    return this.portfolio.accountPortfolio(user, accountId, { withPrices: prices !== 'false' });
  }

  @Get('market-prices/:symbol')
  @ApiRoute({ tag: 'prices', operationId: 'getQuote', summary: 'Latest market price of a ticker, with its source', response: quoteSchema })
  quote(@Param('symbol') symbol: string) {
    return this.prices.getQuote(symbol);
  }
}
