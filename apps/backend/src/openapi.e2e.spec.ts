import { createUpMock, type UpMock } from 'up-bank-mock';
import { buildOpenApiSpec, listRoutes, type RestRoute } from './openapi/build-spec';
import { assertGeneratorCompatible, normalizeSchema } from './openapi/normalize';
import { REST_CONTROLLERS } from './openapi/rest-controllers';
import { createTestApp, type TestApp } from './test-support/test-app';

/** Sorted-key JSON, to compare a response with what its schema keeps of it */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}

describe('OpenAPI spec', () => {
  const routes = listRoutes(REST_CONTROLLERS).filter((r) => r.path.startsWith('/api'));

  it('covers every REST route with a tag, operation ID and response schema', () => {
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) expect(route.options).toBeDefined();
    const spec = buildOpenApiSpec() as { paths: Record<string, Record<string, { operationId: string; tags: string[]; responses: Record<string, unknown> }>> };
    const operations = Object.values(spec.paths).flatMap((methods) => Object.values(methods));
    expect(operations).toHaveLength(routes.length);
    for (const operation of operations) {
      expect(operation.tags).toHaveLength(1);
      expect(Object.keys(operation.responses).some((status) => status.startsWith('2'))).toBe(true);
    }
  });

  it('uses only schema features the client generator supports', () => {
    const spec = buildOpenApiSpec();
    expect(() => assertGeneratorCompatible(spec)).not.toThrow();
    expect(JSON.stringify(spec)).not.toMatch(/"(allOf|anyOf|oneOf)"/);
  });

  it('types decimal amounts as strings and flattens the transaction body', () => {
    const spec = buildOpenApiSpec() as { components: { schemas: Record<string, { properties: Record<string, { type: string; enum?: string[] }>; required?: string[] }> } };
    const body = spec.components.schemas.RecordTransactionRequest;
    expect(body.properties.type.enum).toEqual(['DEPOSIT', 'WITHDRAWAL', 'GAIN_LOSS', 'FX_CONVERSION', 'BUY', 'SELL', 'DIVIDEND']);
    expect(body.properties.amount.type).toBe('string');
    expect(body.properties.quantity.type).toBe('string');
    expect(body.required).toEqual(['type', 'date']);
    expect(spec.components.schemas.Holding.properties.marketValue.type).toBe('string');
  });

  it('refuses unions it cannot express', () => {
    expect(() => normalizeSchema({ anyOf: [{ type: 'number' }, { type: 'boolean' }] })).toThrow(/not supported/);
    expect(() => normalizeSchema({ allOf: [{ type: 'object' }, { type: 'object' }] })).toThrow(/intersection/);
  });
});

describe('REST responses match the OpenAPI response schemas', () => {
  let t: TestApp;
  let token: string;
  let up: UpMock;
  const routes = listRoutes(REST_CONTROLLERS).filter((r) => r.path.startsWith('/api'));
  const covered = new Set<string>();

  beforeAll(async () => {
    up = createUpMock({ retryDelaysMs: [] });
    const baseUrl = await up.listen();
    t = await createTestApp({ env: { UP_API_BASE_URL: baseUrl, UP_REGISTER_WEBHOOK: 'false', UP_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') } });
    token = await t.token({ subject: 'openapi-user' });
  });
  afterAll(async () => {
    await up.close();
    await t.close();
  });

  function routeFor(method: string, url: string): RestRoute {
    const path = url.split('?')[0];
    const route = routes.find((r) => r.method === method && new RegExp(`^${r.path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path));
    if (!route) throw new Error(`No route for ${method} ${path}`);
    return route;
  }

  /** Calls the API and checks the body against the route's response schema, with no undeclared fields */
  async function call(method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, body?: unknown) {
    const route = routeFor(method, url);
    const response = await t.http[method](url).set('Authorization', `Bearer ${token}`).send(body as object);
    expect({ status: response.status, body: response.body }).toMatchObject({ status: route.status });
    const parsed = route.options!.response.safeParse(response.body);
    if (!parsed.success) throw new Error(`${route.options!.operationId}: ${parsed.error.message}`);
    expect(canonical(parsed.data)).toBe(canonical(response.body));
    covered.add(route.options!.operationId);
    return response.body;
  }

  it('for every operation', async () => {
    await call('get', '/api/me');
    const category = await call('post', '/api/categories', { name: 'Core', color: '#336699' });
    await call('patch', `/api/categories/${category.id}`, { description: 'Long-term' });
    await call('get', `/api/categories/${category.id}`);
    await call('get', '/api/categories');

    const broker = await call('post', '/api/accounts', { name: 'Broker', reportingCurrency: 'AUD', categoryId: category.id });
    const bucket = await call('post', '/api/accounts', { name: 'Bucket', type: 'CASH', parentAccountId: broker.id });
    await call('patch', `/api/accounts/${bucket.id}`, { description: 'Savings bucket' });
    await call('get', `/api/accounts/${broker.id}`);
    await call('get', '/api/accounts');

    const tx = (body: object) => call('post', `/api/accounts/${broker.id}/transactions`, body);
    await tx({ type: 'DEPOSIT', date: '2024-01-02', currency: 'AUD', amount: '10000' });
    await tx({ type: 'FX_CONVERSION', date: '2024-01-03', fromCurrency: 'AUD', toCurrency: 'USD', fromAmount: '1000', rate: '0.65' });
    const buy1 = await tx({ type: 'BUY', date: '2024-01-04', symbol: 'VAS.AX', currency: 'AUD', quantity: '10', unitPrice: '90', fees: '5' });
    const buy2 = await tx({ type: 'BUY', date: '2024-02-04', symbol: 'VAS.AX', currency: 'AUD', quantity: '20', unitPrice: '95', fees: '5' });
    const sale = await tx({
      type: 'SELL',
      date: '2024-03-01',
      symbol: 'VAS.AX',
      currency: 'AUD',
      quantity: '5',
      unitPrice: '100',
      fees: '5',
      allocations: [
        { lotId: buy2.id, quantity: '3' },
        { lotId: buy1.id, quantity: '2' },
      ],
    });
    await tx({ type: 'DIVIDEND', date: '2024-03-15', symbol: 'VAS.AX', currency: 'AUD', grossAmount: '20', withholdingTax: '0', frankingCredits: '3' });
    const withdrawal = await tx({ type: 'WITHDRAWAL', date: '2024-03-20', currency: 'AUD', amount: '10' });
    await call('patch', `/api/transactions/${withdrawal.id}`, { amount: '11' });
    await call('get', `/api/transactions/${sale.id}`);
    await call('get', `/api/accounts/${broker.id}/transactions?type=SELL`);
    await call('get', `/api/accounts/${broker.id}/lots?symbol=VAS.AX&includeClosed=true`);
    await call('get', `/api/transactions/${sale.id}/allocations`);
    await call('get', `/api/accounts/${broker.id}/portfolio`);
    await call('get', '/api/market-prices/VAS.AX');

    const transfer = await call('post', '/api/transfers', { fromAccountId: broker.id, toAccountId: bucket.id, date: '2024-04-01', fromCurrency: 'AUD', fromAmount: '100' });
    await call('patch', `/api/transfers/${transfer.id}`, { description: 'Top-up' });
    await call('get', `/api/transfers/${transfer.id}`);
    await call('get', `/api/transfers?accountId=${bucket.id}`);

    await call('put', `/api/accounts/${broker.id}/holdings/VAS.AX/category`, { categoryId: category.id });
    await call('get', `/api/holding-categories?accountId=${broker.id}`);
    await call('delete', `/api/accounts/${broker.id}/holdings/VAS.AX/category`);

    await call('get', '/api/reports/accounts?valuation=cost&baseCurrency=AUD&fxRates=USD:1.5');
    await call('get', '/api/reports/categories?valuation=market');
    await call('get', '/api/dashboard?displayCurrency=USD');
    await call('get', '/api/dashboard?displayCurrency=AUD&fxRates=USD:1.5');
    await call('get', '/api/valuations/status');
    await call('post', '/api/valuations/recompute', { fromDate: '2024-01-01' });
    await call('get', '/api/valuations?fromDate=2024-01-01&toDate=2024-01-10');
    await call('get', '/api/valuations?fromDate=2024-01-01&toDate=2024-01-10&baseCurrency=USD');
    await call('get', '/api/valuations/as-of?date=2024-01-05&baseCurrency=USD');
    await call('get', '/api/valuations/as-of?date=2024-01-05&baseCurrency=USD&fxRates=AUD:0.65');

    await call('delete', `/api/transfers/${transfer.id}`);
    await call('delete', `/api/transactions/${withdrawal.id}`);
    const group = await call('post', '/api/account-groups', { name: 'Everything', members: [{ kind: 'account', id: bucket.id }] });
    await call('patch', `/api/account-groups/${group.id}`, { description: 'All of it' });
    await call('get', `/api/account-groups/${group.id}`);
    await call('get', '/api/account-groups?baseCurrency=AUD&fxRates=USD:1.5');
    await call('delete', `/api/account-groups/${group.id}`);
    await call('delete', `/api/accounts/${bucket.id}`);
    await call('delete', `/api/accounts/${broker.id}?deleteTransactions=true`);
    await call('delete', `/api/categories/${category.id}?unassign=true`);

    // Up! import (read-only), against the mock provider
    const upToken = 'up:user:openapi-mock-token';
    up.addCustomer(upToken);
    await call('get', '/api/up/status');
    await call('post', '/api/up/connection', { token: upToken });
    await call('post', '/api/up/sync');
    const upAccounts = await call('get', '/api/up/accounts?visibility=all');
    await call('put', '/api/up/accounts/visibility', { visibleAccountIds: [upAccounts[0].id] });
    await call('patch', `/api/up/accounts/${upAccounts[0].id}`, { visible: true });
    const upTransactions = await call('get', `/api/up/transactions?accountId=${upAccounts[0].id}&limit=5`);
    const manual = await call('post', '/api/accounts', { name: 'Manual' });
    const deposit = await call('post', `/api/accounts/${manual.id}/transactions`, { type: 'DEPOSIT', date: '2024-01-02', currency: 'AUD', amount: '10' });
    await call('put', `/api/up/transactions/${upTransactions.items[0].id}/match`, { transactionId: deposit.id });
    await call('delete', `/api/up/transactions/${upTransactions.items[0].id}/match`);
    await call('get', '/api/up/sync-runs');
    const found = await call('get', '/api/search/merchants?q=a&visibility=all');
    expect(Array.isArray(found.items)).toBe(true);
    await call('get', '/api/search/accounts?q=manual&visibility=all');
    await call('delete', '/api/up/connection?purge=true');

    const all = routes.map((r) => r.options!.operationId).sort();
    expect([...covered].sort()).toEqual(all);
  });
});
