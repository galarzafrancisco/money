import { DynamicModule, Global, Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { remoteJwks, type JwksSource } from '@taico/auth';
import { AuthExceptionFilter, AuthModule } from '@taico/auth/nest';
import { AccountGroupsRepository } from './account-groups/account-groups.repository';
import { AccountGroupsService } from './account-groups/account-groups.service';
import { AccountsRepository } from './accounts/accounts.repository';
import { AccountsService } from './accounts/accounts.service';
import { UnifiedAccountsService } from './accounts/unified-accounts.service';
import { createMoneyResourceServer, protectedResources } from './auth/auth.setup';
import { MoneyUserGuard } from './auth/user.guard';
import { CategoriesRepository } from './categories/categories.repository';
import { CategoriesService } from './categories/categories.service';
import { DomainErrorFilter } from './common/domain-error.filter';
import { DashboardService } from './dashboard/dashboard.service';
import { APP_CONFIG, type AppConfig } from './config/env.config';
import { dataSourceOptions } from './database/data-source-options';
import { UnitOfWork } from './database/unit-of-work';
import { HealthController } from './health/health.controller';
import { MARKET_PRICE_PROVIDER, type MarketPriceProvider } from './market-prices/market-price.port';
import { PriceStoreRepository } from './market-prices/price-store.repository';
import { ThrottledPriceProvider } from './market-prices/throttled-price.provider';
import { MarketPricesService } from './market-prices/market-prices.service';
import { MockPriceProvider } from './market-prices/mock-price.provider';
import { YahooPriceProvider } from './market-prices/yahoo-price.provider';
import { LotsService } from './lots/lots.service';
import { McpController } from './mcp/mcp.controller';
import { MoneyMcpServerFactory } from './mcp/money-mcp.server';
import { REST_CONTROLLERS } from './openapi/rest-controllers';
import { PortfolioService } from './portfolio/portfolio.service';
import { ReportsService } from './reports/reports.service';
import { TransactionsRepository } from './transactions/transactions.repository';
import { TransactionsService } from './transactions/transactions.service';
import { TransfersRepository } from './transfers/transfers.repository';
import { TransfersService } from './transfers/transfers.service';
import { UsersRepository } from './users/users.repository';
import { PriceHistoryService } from './valuations/price-history.service';
import { ValuationJobService } from './valuations/valuation-job.service';
import { ValuationScheduler } from './valuations/valuation.scheduler';
import { ValuationsRepository } from './valuations/valuations.repository';
import { ValuationsService } from './valuations/valuations.service';
import { UsersService } from './users/users.service';
import { UpApiClient } from './up/up-api.client';
import { UpSyncService, UP_API_CLIENT } from './up/up-sync.service';
import { UpVault } from './up/up-vault';
import { UpWebhookController } from './up/up-webhook.controller';
import { UpWebhookService } from './up/up-webhook.service';
import { UpRepository } from './up/up.repository';
import { UpService } from './up/up.service';
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
  /** Overrides how Money reaches Up (tests normally use the up-bank-mock package over HTTP instead) */
  upFetch?: typeof fetch;
};

export function priceProviderFor(config: AppConfig): MarketPriceProvider {
  return config.marketPrices.provider === 'yahoo' ? new YahooPriceProvider() : new MockPriceProvider();
}

/** Every caller shares one request limit and retry policy (market-prices/throttled-price.provider.ts) */
function throttled(provider: MarketPriceProvider, config: AppConfig): MarketPriceProvider {
  const { maxConcurrent, minIntervalMs, retries } = config.marketPrices;
  return new ThrottledPriceProvider(provider, {
    maxConcurrent,
    minIntervalMs,
    retries,
    retryBaseMs: config.nodeEnv === 'test' ? 1 : 1000,
    maxRetryDelayMs: config.nodeEnv === 'test' ? 5 : 30_000,
  });
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
      controllers: [HealthController, ...REST_CONTROLLERS, McpController, WebAuthController, UpWebhookController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: MARKET_PRICE_PROVIDER, useValue: throttled(options.priceProvider ?? priceProviderFor(config), config) },
        { provide: APP_FILTER, useClass: AuthExceptionFilter },
        { provide: APP_FILTER, useClass: DomainErrorFilter },
        UnitOfWork,
        UsersRepository,
        UsersService,
        MoneyUserGuard,
        AccountsRepository,
        AccountsService,
        UnifiedAccountsService,
        AccountGroupsRepository,
        AccountGroupsService,
        CategoriesRepository,
        CategoriesService,
        ReportsService,
        DashboardService,
        TransactionsRepository,
        TransactionsService,
        LotsService,
        TransfersRepository,
        TransfersService,
        PortfolioService,
        PriceStoreRepository,
        MarketPricesService,
        PriceHistoryService,
        ValuationsRepository,
        ValuationJobService,
        ValuationsService,
        ValuationScheduler,
        { provide: UP_API_CLIENT, useFactory: () => new UpApiClient({ ...config.up, baseUrl: config.up.apiBaseUrl }, options.upFetch ?? fetch) },
        UpRepository,
        UpVault,
        UpSyncService,
        UpService,
        UpWebhookService,
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
