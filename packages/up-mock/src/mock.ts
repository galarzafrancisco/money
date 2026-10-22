import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildFixtures, type FixtureOptions } from './fixtures';
import { SIGNATURE_HEADER, signBody } from './signature';
import type {
  MockAccount,
  MockDelivery,
  MockEvent,
  MockTransaction,
  MockWebhook,
  UpMoney,
  UpWebhookEventType,
} from './types';

export type UpMockOptions = {
  /** Clock for created timestamps of webhooks, events and deliveries (default: real time) */
  now?: () => Date;
  /** Used to deliver webhooks. Default: global fetch, restricted to `deliveryHosts` */
  fetch?: typeof fetch;
  /** Hostnames webhooks may be delivered to. Default: loopback only, so the mock never reaches the internet */
  deliveryHosts?: string[];
  /** Delay before each retry after the first attempt (ms). Default [50, 100, 200] = up to 4 attempts. [] disables retries */
  retryDelaysMs?: number[];
  /** Deliver events as soon as they are emitted (default true). When false, call flush() */
  autoDeliver?: boolean;
  /** Per-attempt delivery timeout in ms (default 5000) */
  deliveryTimeoutMs?: number;
  /** Maximum webhooks per customer (Up documents 10) */
  maxWebhooks?: number;
  /** Expose /__mock__/ admin routes over HTTP. Off by default; the same operations exist as methods */
  adminApi?: boolean;
};

export type AddTransactionInput = {
  accountId: string;
  description: string;
  /** Signed base units (cents): negative = money out */
  amountInBaseUnits: number;
  status?: 'HELD' | 'SETTLED';
  createdAt?: string;
  currencyCode?: string;
  message?: string | null;
  categoryId?: string | null;
  tags?: string[];
  transferAccountId?: string | null;
  transactionType?: string | null;
  foreignAmount?: MockTransaction['foreignAmount'];
  /** Emit a webhook event (default true) */
  emit?: boolean;
};

type Customer = {
  token: string;
  revoked: boolean;
  accounts: Map<string, MockAccount>;
  transactions: Map<string, MockTransaction>;
  webhooks: Map<string, MockWebhook>;
};

const PAGE_DEFAULT = 30;
const PAGE_MAX = 100;
const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]'];

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    detail: string,
    readonly source?: { parameter?: string; pointer?: string },
  ) {
    super(detail);
  }
}

/**
 * An offline stand-in for the Up (up.com.au) API. See docs/CONTRACT.md for
 * which behaviours are documented by Up and which are emulation choices.
 */
export class UpMock {
  readonly options: Required<Omit<UpMockOptions, 'fetch' | 'now'>> & Pick<UpMockOptions, 'fetch' | 'now'>;
  private readonly customers = new Map<string, Customer>();
  private readonly counters = new Map<string, number>();
  private readonly pendingEvents: MockEvent[] = [];
  private readonly inflight = new Set<Promise<void>>();
  /** Deliveries log, oldest first */
  readonly deliveries: MockDelivery[] = [];
  /** Events emitted, oldest first */
  readonly events: MockEvent[] = [];
  /** The next N delivery attempts are answered by this stand-in instead of the receiver (failure injection) */
  private forcedFailures: { status: number | 'timeout'; remaining: number }[] = [];
  private server: Server | null = null;
  private port = 0;

  constructor(options: UpMockOptions = {}) {
    this.options = {
      now: options.now,
      fetch: options.fetch,
      deliveryHosts: options.deliveryHosts ?? LOOPBACK,
      retryDelaysMs: options.retryDelaysMs ?? [50, 100, 200],
      autoDeliver: options.autoDeliver ?? true,
      deliveryTimeoutMs: options.deliveryTimeoutMs ?? 5000,
      maxWebhooks: options.maxWebhooks ?? 10,
      adminApi: options.adminApi ?? false,
    };
  }

  // ---------- lifecycle ----------

  /** Starts listening on 127.0.0.1 (random port by default) and returns the API base URL, e.g. http://127.0.0.1:41234/api/v1 */
  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this.baseUrl;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/api/v1`;
  }

  async close(): Promise<void> {
    await this.idle();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
  }

  /** Resolves when every in-flight delivery (including retries) has finished */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  // ---------- customers and tokens ----------

  /**
   * Creates a customer (an Up user) reachable with `token`. With `fixtures`
   * (default true) it gets the standard deterministic accounts and history.
   * Account and transaction IDs are deterministic for a given creation order.
   */
  addCustomer(token: string, options: { fixtures?: boolean | FixtureOptions } = {}): { token: string; accountIds: string[] } {
    if (this.customers.has(token)) throw new Error('A customer with this token already exists');
    const customer: Customer = { token, revoked: false, accounts: new Map(), transactions: new Map(), webhooks: new Map() };
    this.customers.set(token, customer);
    const accountIds: string[] = [];
    if (options.fixtures !== false) {
      const fixtures = buildFixtures(typeof options.fixtures === 'object' ? options.fixtures : {});
      for (const account of fixtures.accounts) {
        const id = this.nextId('account');
        customer.accounts.set(id, { ...account, id });
        accountIds.push(id);
      }
      for (const { accountIndex, ...transaction } of fixtures.transactions) {
        const id = this.nextId('transaction');
        customer.transactions.set(id, { ...transaction, id, accountId: accountIds[accountIndex] });
      }
    }
    return { token, accountIds };
  }

  revokeToken(token: string): void {
    this.customer(token).revoked = true;
  }

  restoreToken(token: string): void {
    this.customer(token).revoked = false;
  }

  /** Replaces a customer's token (Up personal tokens can be regenerated); the old one stops working */
  rotateToken(oldToken: string, newToken: string): void {
    const customer = this.customer(oldToken);
    if (this.customers.has(newToken)) throw new Error('New token already in use');
    this.customers.delete(oldToken);
    customer.token = newToken;
    this.customers.set(newToken, customer);
  }

  // ---------- data ----------

  accountsOf(token: string): MockAccount[] {
    return [...this.customer(token).accounts.values()];
  }

  transactionsOf(token: string): MockTransaction[] {
    return [...this.customer(token).transactions.values()];
  }

  webhooksOf(token: string): MockWebhook[] {
    return [...this.customer(token).webhooks.values()];
  }

  addAccount(token: string, input: { displayName: string; accountType?: MockAccount['accountType']; ownershipType?: MockAccount['ownershipType']; currencyCode?: string }): MockAccount {
    const customer = this.customer(token);
    const id = this.nextId('account');
    const account: MockAccount = {
      id,
      displayName: input.displayName,
      accountType: input.accountType ?? 'TRANSACTIONAL',
      ownershipType: input.ownershipType ?? 'INDIVIDUAL',
      balanceInBaseUnits: 0,
      currencyCode: input.currencyCode ?? 'AUD',
      createdAt: this.nowIso(),
    };
    customer.accounts.set(id, account);
    return account;
  }

  /** Adds a transaction, adjusts the account balance and (by default) emits TRANSACTION_CREATED */
  addTransaction(token: string, input: AddTransactionInput): MockTransaction {
    const customer = this.customer(token);
    const account = customer.accounts.get(input.accountId);
    if (!account) throw new Error('Unknown account');
    const status = input.status ?? 'SETTLED';
    const createdAt = input.createdAt ?? this.nowIso();
    const transaction: MockTransaction = {
      id: this.nextId('transaction'),
      accountId: account.id,
      status,
      rawText: input.description.toUpperCase(),
      description: input.description,
      message: input.message ?? null,
      amountInBaseUnits: input.amountInBaseUnits,
      currencyCode: input.currencyCode ?? account.currencyCode,
      foreignAmount: input.foreignAmount ?? null,
      transactionType: input.transactionType ?? null,
      transferAccountId: input.transferAccountId ?? null,
      categoryId: input.categoryId ?? null,
      tags: input.tags ?? [],
      createdAt,
      settledAt: status === 'SETTLED' ? createdAt : null,
    };
    customer.transactions.set(transaction.id, transaction);
    // Up's account balance includes held amounts
    account.balanceInBaseUnits += transaction.amountInBaseUnits;
    if (input.emit !== false) this.emit(token, 'TRANSACTION_CREATED', transaction.id);
    return transaction;
  }

  /** HELD -> SETTLED. `amountInBaseUnits` may change on settlement (e.g. a tip). Emits TRANSACTION_SETTLED */
  settleTransaction(token: string, transactionId: string, options: { amountInBaseUnits?: number; emit?: boolean } = {}): MockTransaction {
    const customer = this.customer(token);
    const transaction = customer.transactions.get(transactionId);
    if (!transaction) throw new Error('Unknown transaction');
    if (options.amountInBaseUnits !== undefined) {
      customer.accounts.get(transaction.accountId)!.balanceInBaseUnits += options.amountInBaseUnits - transaction.amountInBaseUnits;
      transaction.amountInBaseUnits = options.amountInBaseUnits;
    }
    transaction.status = 'SETTLED';
    transaction.settledAt = this.nowIso();
    if (options.emit !== false) this.emit(token, 'TRANSACTION_SETTLED', transaction.id);
    return transaction;
  }

  /** Removes a transaction (Up deletes held transactions that never settle) and emits TRANSACTION_DELETED */
  deleteTransaction(token: string, transactionId: string, options: { emit?: boolean } = {}): void {
    const customer = this.customer(token);
    const transaction = customer.transactions.get(transactionId);
    if (!transaction) throw new Error('Unknown transaction');
    customer.accounts.get(transaction.accountId)!.balanceInBaseUnits -= transaction.amountInBaseUnits;
    customer.transactions.delete(transactionId);
    if (options.emit !== false) this.emit(token, 'TRANSACTION_DELETED', transactionId);
  }

  // ---------- webhooks and delivery ----------

  /** Same effect as POST /webhooks. Returns the webhook including its secretKey */
  createWebhook(token: string, url: string, description: string | null = null): MockWebhook {
    const customer = this.customer(token);
    validateWebhookUrl(url, description);
    if (customer.webhooks.size >= this.options.maxWebhooks) {
      throw new HttpError(422, 'Webhook limit reached', `There is a limit of ${this.options.maxWebhooks} webhooks`);
    }
    const id = this.nextId('webhook');
    const webhook: MockWebhook = { id, url, description, secretKey: this.secretFor(id), createdAt: this.nowIso() };
    customer.webhooks.set(id, webhook);
    return webhook;
  }

  /**
   * Creates an event for every webhook of the customer and, with autoDeliver,
   * starts delivering. Returns the events created.
   */
  emit(token: string, eventType: UpWebhookEventType, transactionId: string | null): MockEvent[] {
    const customer = this.customer(token);
    const created: MockEvent[] = [];
    for (const webhook of customer.webhooks.values()) {
      const event: MockEvent = { id: this.nextId('event'), webhookId: webhook.id, eventType, transactionId, createdAt: this.nowIso() };
      this.events.push(event);
      created.push(event);
      this.pendingEvents.push(event);
    }
    if (this.options.autoDeliver) void this.flush();
    return created;
  }

  /** Events emitted but not yet delivered (autoDeliver false), oldest first */
  get pending(): readonly MockEvent[] {
    return this.pendingEvents;
  }

  /**
   * Delivers pending events. `order` can reorder them (e.g. `(e) => e.reverse()`)
   * to produce out-of-order delivery. Resolves when delivery, including
   * retries, has finished.
   */
  async flush(order?: (events: MockEvent[]) => MockEvent[]): Promise<void> {
    let batch = this.pendingEvents.splice(0);
    if (order) batch = order(batch);
    // Events go out sequentially in the given order; a failing event retries before the next starts
    const run = (async () => {
      for (const event of batch) await this.deliver(event);
    })();
    this.track(run);
    await run;
  }

  /** Re-sends an already emitted event exactly as before (same event id): a duplicate delivery */
  async redeliver(eventId: string): Promise<void> {
    const event = this.events.find((candidate) => candidate.id === eventId);
    if (!event) throw new Error('Unknown event');
    const run = this.deliver(event);
    this.track(run);
    await run;
  }

  /** Makes the next `count` delivery attempts fail with this HTTP status, or time out, without contacting the receiver */
  failNextDeliveries(count: number, status: number | 'timeout' = 500): void {
    this.forcedFailures.push({ status, remaining: count });
  }

  private track(promise: Promise<void>): void {
    const tracked = promise.catch(() => undefined).finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  private async deliver(event: MockEvent): Promise<void> {
    const customer = [...this.customers.values()].find((candidate) => candidate.webhooks.has(event.webhookId));
    const webhook = customer?.webhooks.get(event.webhookId);
    if (!webhook) return; // webhook deleted before delivery
    const body = JSON.stringify(eventBody(event, this.baseUrl));
    const attempts = this.options.retryDelaysMs.length + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(this.options.retryDelaysMs[attempt - 2]);
      if (!customer!.webhooks.has(webhook.id)) return;
      const result = await this.attempt(webhook, body);
      this.deliveries.push({
        id: this.nextId('delivery'),
        webhookId: webhook.id,
        eventId: event.id,
        eventType: event.eventType,
        attempt,
        requestBody: body,
        responseStatus: result.status,
        responseBody: result.body,
        deliveryStatus: result.status === 200 ? 'DELIVERED' : result.status === null ? 'UNDELIVERABLE' : 'BAD_RESPONSE_CODE',
        createdAt: this.nowIso(),
      });
      if (result.status === 200) return;
    }
  }

  private async attempt(webhook: MockWebhook, body: string): Promise<{ status: number | null; body: string | null }> {
    const forced = this.forcedFailures[0];
    if (forced) {
      if (--forced.remaining <= 0) this.forcedFailures.shift();
      return { status: forced.status === 'timeout' ? null : forced.status, body: null };
    }
    const host = new URL(webhook.url).hostname;
    if (!this.options.deliveryHosts.includes(host)) return { status: null, body: 'Delivery blocked: host is not in deliveryHosts (the mock never contacts the internet)' };
    const send = this.options.fetch ?? fetch;
    try {
      const response = await send(webhook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signBody(body, webhook.secretKey) },
        body,
        signal: AbortSignal.timeout(this.options.deliveryTimeoutMs),
      });
      return { status: response.status, body: (await response.text()).slice(0, 1000) };
    } catch {
      return { status: null, body: null };
    }
  }

  // ---------- internals ----------

  private customer(token: string): Customer {
    const customer = this.customers.get(token);
    if (!customer) throw new Error('Unknown customer token');
    return customer;
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private nextId(kind: 'account' | 'transaction' | 'webhook' | 'event' | 'delivery'): string {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const prefix = { account: 'a', transaction: 'b', webhook: 'c', event: 'd', delivery: 'e' }[kind];
    return `${prefix}0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  }

  /** Deterministic per-webhook secret so tests can predict nothing sensitive but stay repeatable */
  private secretFor(webhookId: string): string {
    return `mock-secret-${webhookId.slice(-12)}`;
  }

  // ---------- HTTP ----------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://mock');
      const raw = await readBody(req);
      if (url.pathname.startsWith('/__mock__/')) {
        if (!this.options.adminApi) throw new HttpError(404, 'Not Found', 'Admin API disabled');
        return send(res, 200, this.admin(req.method ?? 'GET', url, raw));
      }
      if (!url.pathname.startsWith('/api/v1/')) throw new HttpError(404, 'Not Found', 'No such route');
      const path = url.pathname.slice('/api/v1'.length);
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const customer = token ? this.customers.get(token) : undefined;
      if (!customer || customer.revoked) {
        throw new HttpError(401, 'Not Authorized', 'The request was not authenticated because no valid credential was found in the Authorization header, or the Authorization header was not present.');
      }
      const result = this.route(customer, req.method ?? 'GET', path, url, raw);
      send(res, result.status ?? 200, result.body);
    } catch (error) {
      if (error instanceof HttpError) {
        send(res, error.status, { errors: [{ status: String(error.status), title: error.title, detail: error.message, ...(error.source ? { source: error.source } : {}) }] });
      } else {
        send(res, 500, { errors: [{ status: '500', title: 'Internal Server Error', detail: 'Mock failure' }] });
      }
    }
  }

  private route(customer: Customer, method: string, path: string, url: URL, raw: string): { status?: number; body: unknown } {
    const base = this.baseUrl;
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/util/ping') return { body: { meta: { id: '00000000-0000-4000-8000-000000000000', statusEmoji: '⚡️' } } };
    if (method === 'GET' && path === '/accounts') {
      const accounts = [...customer.accounts.values()].sort(byCreated);
      return { body: this.page(accounts, url, (a) => accountResource(a, base)) };
    }
    if (method === 'GET' && (m = /^\/accounts\/([^/]+)$/.exec(path))) {
      const account = customer.accounts.get(m[1]);
      if (!account) throw notFound('account');
      return { body: { data: accountResource(account, base) } };
    }
    if (method === 'GET' && (m = /^\/accounts\/([^/]+)\/transactions$/.exec(path))) {
      if (!customer.accounts.has(m[1])) throw notFound('account');
      return { body: this.transactionPage(customer, url, m[1]) };
    }
    if (method === 'GET' && path === '/transactions') return { body: this.transactionPage(customer, url, null) };
    if (method === 'GET' && (m = /^\/transactions\/([^/]+)$/.exec(path))) {
      const transaction = customer.transactions.get(m[1]);
      if (!transaction) throw notFound('transaction');
      return { body: { data: transactionResource(transaction, base) } };
    }
    if (method === 'GET' && path === '/webhooks') {
      return { body: this.page([...customer.webhooks.values()], url, (w) => webhookResource(w, base, false)) };
    }
    if (method === 'POST' && path === '/webhooks') {
      const attributes = parseJson(raw)?.data?.attributes;
      if (!attributes || typeof attributes.url !== 'string') throw new HttpError(422, 'Invalid request', 'data.attributes.url is required', { pointer: '/data/attributes/url' });
      const webhook = this.createWebhook(customerToken(customer), attributes.url, typeof attributes.description === 'string' ? attributes.description : null);
      return { status: 201, body: { data: webhookResource(webhook, base, true) } };
    }
    if ((m = /^\/webhooks\/([^/]+)$/.exec(path))) {
      const webhook = customer.webhooks.get(m[1]);
      if (!webhook) throw notFound('webhook');
      if (method === 'GET') return { body: { data: webhookResource(webhook, base, false) } };
      if (method === 'DELETE') {
        customer.webhooks.delete(webhook.id);
        return { status: 204, body: undefined };
      }
    }
    if (method === 'POST' && (m = /^\/webhooks\/([^/]+)\/ping$/.exec(path))) {
      const webhook = customer.webhooks.get(m[1]);
      if (!webhook) throw notFound('webhook');
      const event: MockEvent = { id: this.nextId('event'), webhookId: webhook.id, eventType: 'PING', transactionId: null, createdAt: this.nowIso() };
      this.events.push(event);
      this.pendingEvents.push(event);
      if (this.options.autoDeliver) void this.flush();
      return { status: 201, body: { data: eventResource(event, base) } };
    }
    if (method === 'GET' && (m = /^\/webhooks\/([^/]+)\/logs$/.exec(path))) {
      const webhook = customer.webhooks.get(m[1]);
      if (!webhook) throw notFound('webhook');
      const logs = this.deliveries.filter((d) => d.webhookId === webhook.id).reverse();
      return { body: this.page(logs, url, (d) => logResource(d, base)) };
    }
    throw new HttpError(404, 'Not Found', 'No such route');
  }

  private transactionPage(customer: Customer, url: URL, accountId: string | null) {
    const q = url.searchParams;
    const status = q.get('filter[status]');
    if (status && status !== 'HELD' && status !== 'SETTLED') throw new HttpError(400, 'Invalid Filter', 'filter[status] must be HELD or SETTLED', { parameter: 'filter[status]' });
    const since = parseTime(q.get('filter[since]'), 'filter[since]');
    const until = parseTime(q.get('filter[until]'), 'filter[until]');
    const category = q.get('filter[category]');
    const tag = q.get('filter[tag]');
    const rows = [...customer.transactions.values()]
      .filter((t) => (accountId ? t.accountId === accountId : true))
      .filter((t) => (status ? t.status === status : true))
      .filter((t) => (since === null ? true : Date.parse(t.createdAt) >= since))
      .filter((t) => (until === null ? true : Date.parse(t.createdAt) < until))
      .filter((t) => (category ? t.categoryId === category : true))
      .filter((t) => (tag ? t.tags.includes(tag) : true))
      // newest first, as Up returns them
      .sort((a, b) => byCreated(b, a));
    return this.page(rows, url, (t) => transactionResource(t, this.baseUrl));
  }

  /** Cursor pagination. `links.next` is an opaque URL the client must follow, as with Up */
  private page<T>(rows: T[], url: URL, resource: (row: T) => unknown) {
    const sizeParam = url.searchParams.get('page[size]');
    let size = PAGE_DEFAULT;
    if (sizeParam !== null) {
      size = Number(sizeParam);
      if (!Number.isInteger(size) || size < 1 || size > PAGE_MAX) {
        throw new HttpError(400, 'Invalid Page Size', `page[size] must be an integer from 1 to ${PAGE_MAX}`, { parameter: 'page[size]' });
      }
    }
    const after = url.searchParams.get('page[after]');
    const offset = after ? Number(Buffer.from(after, 'base64url').toString()) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'Invalid Cursor', 'page[after] is not valid', { parameter: 'page[after]' });
    const slice = rows.slice(offset, offset + size);
    const link = (target: number | null) => {
      if (target === null) return null;
      const next = new URL(url.pathname, this.baseUrl.replace(/\/api\/v1$/, ''));
      for (const [key, value] of url.searchParams) if (key !== 'page[after]') next.searchParams.append(key, value);
      next.searchParams.set('page[size]', String(size));
      if (target > 0) next.searchParams.set('page[after]', Buffer.from(String(target)).toString('base64url'));
      return next.toString();
    };
    return {
      data: slice.map(resource),
      links: { prev: offset > 0 ? link(Math.max(0, offset - size)) : null, next: offset + size < rows.length ? link(offset + size) : null },
    };
  }

  private admin(method: string, url: URL, raw: string): unknown {
    const body = parseJson(raw) ?? {};
    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    if (method === 'POST' && parts[0] === 'customers' && parts.length === 1) return this.addCustomer(body.token, { fixtures: body.fixtures ?? true });
    const token = decodeURIComponent(parts[1] ?? '');
    if (method === 'POST' && parts[0] === 'tokens' && parts[2] === 'revoke') return this.revokeToken(token), { ok: true };
    if (method === 'POST' && parts[0] === 'customers' && parts[2] === 'transactions' && parts.length === 3) return this.addTransaction(token, body);
    if (method === 'POST' && parts[0] === 'customers' && parts[2] === 'transactions' && parts[4] === 'settle') return this.settleTransaction(token, parts[3], body);
    if (method === 'DELETE' && parts[0] === 'customers' && parts[2] === 'transactions') return this.deleteTransaction(token, parts[3]), { ok: true };
    if (method === 'POST' && parts[0] === 'flush') return { pending: this.pendingEvents.length };
    throw new HttpError(404, 'Not Found', 'No such admin route');
  }
}

export function createUpMock(options?: UpMockOptions): UpMock {
  return new UpMock(options);
}

// ---------- resources ----------

const money = (currencyCode: string, units: number): UpMoney => ({
  currencyCode,
  value: (units / 100).toFixed(2),
  valueInBaseUnits: units,
});

function accountResource(a: MockAccount, base: string) {
  return {
    type: 'accounts',
    id: a.id,
    attributes: { displayName: a.displayName, accountType: a.accountType, ownershipType: a.ownershipType, balance: money(a.currencyCode, a.balanceInBaseUnits), createdAt: a.createdAt },
    relationships: { transactions: { links: { related: `${base}/accounts/${a.id}/transactions` } } },
    links: { self: `${base}/accounts/${a.id}` },
  };
}

function transactionResource(t: MockTransaction, base: string) {
  const ref = (type: string, id: string | null) => ({ data: id ? { type, id } : null });
  return {
    type: 'transactions',
    id: t.id,
    attributes: {
      status: t.status,
      rawText: t.rawText,
      description: t.description,
      message: t.message,
      isCategorizable: true,
      holdInfo: null,
      roundUp: null,
      cashback: null,
      amount: money(t.currencyCode, t.amountInBaseUnits),
      foreignAmount: t.foreignAmount ? money(t.foreignAmount.currencyCode, t.foreignAmount.valueInBaseUnits) : null,
      cardPurchaseMethod: null,
      settledAt: t.settledAt,
      createdAt: t.createdAt,
      transactionType: t.transactionType,
      note: null,
      performingCustomer: { displayName: 'Mock Customer' },
      deepLinkURL: `up://transaction/${t.id}`,
    },
    relationships: {
      account: { data: { type: 'accounts', id: t.accountId }, links: { related: `${base}/accounts/${t.accountId}` } },
      transferAccount: ref('accounts', t.transferAccountId),
      category: ref('categories', t.categoryId),
      parentCategory: ref('categories', null),
      tags: { data: t.tags.map((id) => ({ type: 'tags', id })) },
    },
    links: { self: `${base}/transactions/${t.id}` },
  };
}

function webhookResource(w: MockWebhook, base: string, includeSecret: boolean) {
  return {
    type: 'webhooks',
    id: w.id,
    attributes: { url: w.url, description: w.description, ...(includeSecret ? { secretKey: w.secretKey } : {}), createdAt: w.createdAt },
    relationships: { logs: { links: { related: `${base}/webhooks/${w.id}/logs` } } },
    links: { self: `${base}/webhooks/${w.id}` },
  };
}

function eventResource(e: MockEvent, base: string) {
  return {
    type: 'webhook-events',
    id: e.id,
    attributes: { eventType: e.eventType, createdAt: e.createdAt },
    relationships: {
      webhook: { data: { type: 'webhooks', id: e.webhookId }, links: { related: `${base}/webhooks/${e.webhookId}` } },
      ...(e.transactionId ? { transaction: { data: { type: 'transactions', id: e.transactionId }, links: { related: `${base}/transactions/${e.transactionId}` } } } : {}),
    },
  };
}

/** The body Up POSTs to the receiver */
function eventBody(e: MockEvent, base: string) {
  return { data: eventResource(e, base) };
}

function logResource(d: MockDelivery, base: string) {
  return {
    type: 'webhook-delivery-logs',
    id: d.id,
    attributes: {
      request: { body: d.requestBody },
      response: d.responseStatus === null ? null : { statusCode: d.responseStatus, body: d.responseBody ?? '' },
      deliveryStatus: d.deliveryStatus,
      createdAt: d.createdAt,
    },
    relationships: { webhookEvent: { data: { type: 'webhook-events', id: d.eventId } } },
  };
}

// ---------- helpers ----------

function customerToken(customer: Customer): string {
  return customer.token;
}

function validateWebhookUrl(url: string, description: string | null): void {
  if (url.length > 300) throw new HttpError(422, 'Invalid URL', 'The URL must be no more than 300 characters', { pointer: '/data/attributes/url' });
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new HttpError(422, 'Invalid URL', 'The URL must be a valid HTTP or HTTPS URL', { pointer: '/data/attributes/url' });
  }
  if (description !== null && description.length > 64) throw new HttpError(422, 'Invalid description', 'The description must be no more than 64 characters', { pointer: '/data/attributes/description' });
}

const notFound = (what: string) => new HttpError(404, 'Not Found', `The given ${what} was not found.`);
const byCreated = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

function parseTime(value: string | null, parameter: string): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new HttpError(400, 'Invalid Filter', `${parameter} must be an RFC 3339 date-time`, { parameter });
  return parsed;
}

function parseJson(raw: string): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON', 'The request body is not valid JSON');
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
