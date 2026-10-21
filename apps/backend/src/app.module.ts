import { DynamicModule, Global, Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { remoteJwks, type JwksSource } from '@taico/auth';
import { AuthExceptionFilter, AuthModule } from '@taico/auth/nest';
import { AccountsController } from './accounts/accounts.controller';
import { AccountsRepository } from './accounts/accounts.repository';
import { AccountsService } from './accounts/accounts.service';
import { createMoneyResourceServer, protectedResources } from './auth/auth.setup';
import { MoneyUserGuard } from './auth/user.guard';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesRepository } from './categories/categories.repository';
import { CategoriesService } from './categories/categories.service';
import { DomainErrorFilter } from './common/domain-error.filter';
import { APP_CONFIG, type AppConfig } from './config/env.config';
import { dataSourceOptions } from './database/data-source-options';
import { UnitOfWork } from './database/unit-of-work';
import { HealthController } from './health/health.controller';
import { MARKET_PRICE_PROVIDER, type MarketPriceProvider } from './market-prices/market-price.port';
import { MarketPricesService } from './market-prices/market-prices.service';
import { MockPriceProvider } from './market-prices/mock-price.provider';
import { YahooPriceProvider } from './market-prices/yahoo-price.provider';
import { LotsController } from './lots/lots.controller';
import { LotsService } from './lots/lots.service';
import { McpController } from './mcp/mcp.controller';
import { MoneyMcpServerFactory } from './mcp/money-mcp.server';
import { PortfolioController } from './portfolio/portfolio.controller';
import { PortfolioService } from './portfolio/portfolio.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { TransactionsController } from './transactions/transactions.controller';
import { TransactionsRepository } from './transactions/transactions.repository';
import { TransactionsService } from './transactions/transactions.service';
import { TransfersController } from './transfers/transfers.controller';
import { TransfersRepository } from './transfers/transfers.repository';
import { TransfersService } from './transfers/transfers.service';
import { UsersRepository } from './users/users.repository';
import { PriceHistoryService } from './valuations/price-history.service';
import { ValuationJobService } from './valuations/valuation-job.service';
import { ValuationScheduler } from './valuations/valuation.scheduler';
import { ValuationsController } from './valuations/valuations.controller';
import { ValuationsRepository } from './valuations/valuations.repository';
import { ValuationsService } from './valuations/valuations.service';
import { UsersService } from './users/users.service';
import { SessionAuthMiddleware } from './web-auth/session-auth.middleware';
import { TaicoWebClient } from './web-auth/taico-web-client';
import { WebAuthController } from './web-auth/web-auth.controller';
import { MONEY_RESOURCE_SERVER, WebAuthService } from './web-auth/web-auth.service';
import { WebSessionsRepository } from './web-auth/web-sessions.repository';

export type AppModuleOptions = {
  config: AppConfig;
  /** Overrides Taico's remote JWKS (tests sign their own tokens) */
  jwks?: JwksSource;
  /** Overrides the provider chosen by MARKET_PRICE_PROVIDER */
  priceProvider?: MarketPriceProvider;
  /** Overrides how browser sign-in talks to Taico (tests stand in a fake authorization server) */
  webAuthFetch?: typeof fetch;
};

export function priceProviderFor(config: AppConfig): MarketPriceProvider {
  return config.marketPrices.provider === 'yahoo' ? new YahooPriceProvider() : new MockPriceProvider();
}

@Global()
@Module({})
export class AppModule implements NestModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config } = options;
    const resourceServer = createMoneyResourceServer(config, options.jwks ?? remoteJwks(config.auth.jwksUrl));
    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({ ...dataSourceOptions(config.database), retryAttempts: config.nodeEnv === 'test' ? 0 : 5 }),
        AuthModule.forRoot({
          resourceServer,
          metadata: { resources: protectedResources(config), authorizationServers: config.auth.authorizationServers },
        }),
      ],
      controllers: [HealthController, AccountsController, TransactionsController, LotsController, PortfolioController, CategoriesController, ReportsController, TransfersController, ValuationsController, McpController, WebAuthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: MARKET_PRICE_PROVIDER, useValue: options.priceProvider ?? priceProviderFor(config) },
        { provide: APP_FILTER, useClass: AuthExceptionFilter },
        { provide: APP_FILTER, useClass: DomainErrorFilter },
        UnitOfWork,
        UsersRepository,
        UsersService,
        MoneyUserGuard,
        AccountsRepository,
        AccountsService,
        CategoriesRepository,
        CategoriesService,
        ReportsService,
        TransactionsRepository,
        TransactionsService,
        LotsService,
        TransfersRepository,
        TransfersService,
        PortfolioService,
        MarketPricesService,
        PriceHistoryService,
        ValuationsRepository,
        ValuationJobService,
        ValuationsService,
        ValuationScheduler,
        MoneyMcpServerFactory,
        { provide: MONEY_RESOURCE_SERVER, useValue: resourceServer },
        { provide: TaicoWebClient, useValue: new TaicoWebClient(config, options.webAuthFetch) },
        WebSessionsRepository,
        WebAuthService,
        SessionAuthMiddleware,
      ],
      exports: [MARKET_PRICE_PROVIDER, MarketPricesService, ValuationJobService],
    };
  }

  /** The web app's session cookie is accepted on the REST API only, never on /mcp (docs/web-auth.md) */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionAuthMiddleware).forRoutes({ path: 'api', method: RequestMethod.ALL }, { path: 'api/{*path}', method: RequestMethod.ALL });
  }
}
