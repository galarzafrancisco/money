import { Controller, Get, Param, Query } from '@nestjs/common';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import { MarketPricesService } from '../market-prices/market-prices.service';
import type { CurrentUser } from '../users/users.service';
import { PortfolioService } from './portfolio.service';

@Controller('api')
@Protected()
export class PortfolioController {
  constructor(
    private readonly portfolio: PortfolioService,
    private readonly prices: MarketPricesService,
  ) {}

  @Get('me')
  me(@AuthenticatedUser() user: CurrentUser) {
    return user;
  }

  /** Cash per currency, holdings with lots and valuations, realized gains and dividends. ?prices=false skips price lookups. */
  @Get('accounts/:accountId/portfolio')
  accountPortfolio(@AuthenticatedUser() user: CurrentUser, @Param('accountId') accountId: string, @Query('prices') prices?: string) {
    return this.portfolio.accountPortfolio(user, accountId, { withPrices: prices !== 'false' });
  }

  @Get('market-prices/:symbol')
  quote(@Param('symbol') symbol: string) {
    return this.prices.getQuote(symbol);
  }
}
