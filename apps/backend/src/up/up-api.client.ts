import { z } from 'zod';

/** Up refused the personal access token (HTTP 401) */
export class UpAuthRejectedError extends Error {
  constructor() {
    super('Up rejected the access token');
  }
}

/** Up could not be reached, timed out, or answered unexpectedly. Never carries the token or a response body */
export class UpUnavailableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const money = z.object({ currencyCode: z.string(), value: z.string() });
const ref = z.object({ data: z.object({ id: z.string() }).nullable().optional() }).optional();

const accountResource = z.object({
  id: z.string(),
  attributes: z.object({
    displayName: z.string(),
    accountType: z.string(),
    ownershipType: z.string(),
    balance: money,
    createdAt: z.string(),
  }),
});

const transactionResource = z.object({
  id: z.string(),
  attributes: z.object({
    status: z.enum(['HELD', 'SETTLED']),
    rawText: z.string().nullable().optional(),
    description: z.string(),
    message: z.string().nullable().optional(),
    amount: money,
    foreignAmount: money.nullable().optional(),
    settledAt: z.string().nullable().optional(),
    createdAt: z.string(),
    transactionType: z.string().nullable().optional(),
  }),
  relationships: z.object({ account: ref, transferAccount: ref, category: ref }).optional(),
});

export type UpAccount = z.infer<typeof accountResource>;
export type UpTransaction = z.infer<typeof transactionResource>;

const page = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item), links: z.object({ next: z.string().nullable().optional() }).optional() });
const webhookCreated = z.object({ data: z.object({ id: z.string(), attributes: z.object({ secretKey: z.string() }) }) });

export type UpClientSettings = { baseUrl: string; pageSize: number; maxPages: number; requestTimeoutMs: number };

/**
 * Read-only client for the Up API. The only mutating calls are registering and
 * removing Money's own webhook. Nothing here can move money (Up's API offers no
 * such operation to personal tokens, and none is called).
 *
 * The token travels only in the Authorization header to the configured base
 * URL's origin. Pagination links are followed only when they stay on that
 * origin, so a malicious link cannot redirect the token elsewhere.
 */
export class UpApiClient {
  constructor(
    private readonly settings: UpClientSettings,
    private readonly fetchImpl: typeof fetch,
  ) {}

  listAccounts(token: string): Promise<UpAccount[]> {
    return this.collect(token, `${this.settings.baseUrl}/accounts?page[size]=${this.settings.pageSize}`, accountResource);
  }

  /** Null when Up answers 404 */
  async getAccount(token: string, upAccountId: string): Promise<UpAccount | null> {
    const response = await this.request(token, 'GET', `${this.settings.baseUrl}/accounts/${encodeURIComponent(upAccountId)}`, undefined, true);
    return response ? z.object({ data: accountResource }).parse(response).data : null;
  }

  /** Newest first. `since` is an ISO timestamp (filter[since]) */
  listTransactions(token: string, upAccountId: string, since: string | null): Promise<UpTransaction[]> {
    const url = new URL(`${this.settings.baseUrl}/accounts/${encodeURIComponent(upAccountId)}/transactions`);
    url.searchParams.set('page[size]', String(this.settings.pageSize));
    if (since) url.searchParams.set('filter[since]', since);
    return this.collect(token, url.toString(), transactionResource);
  }

  /** Null when Up answers 404 (deleted, or never existed) */
  async getTransaction(token: string, upTransactionId: string): Promise<UpTransaction | null> {
    const response = await this.request(token, 'GET', `${this.settings.baseUrl}/transactions/${encodeURIComponent(upTransactionId)}`, undefined, true);
    if (!response) return null;
    return z.object({ data: transactionResource }).parse(response).data;
  }

  /** The user's existing webhooks (id and URL). The secret is never listed by Up */
  async listWebhooks(token: string): Promise<{ id: string; url: string }[]> {
    const rows = await this.collect(token, `${this.settings.baseUrl}/webhooks?page[size]=100`, z.object({ id: z.string(), attributes: z.object({ url: z.string() }) }));
    return rows.map((row) => ({ id: row.id, url: row.attributes.url }));
  }

  async createWebhook(token: string, url: string, description: string): Promise<{ id: string; secretKey: string }> {
    const body = { data: { attributes: { url, description } } };
    const response = webhookCreated.parse(await this.request(token, 'POST', `${this.settings.baseUrl}/webhooks`, body));
    return { id: response.data.id, secretKey: response.data.attributes.secretKey };
  }

  async deleteWebhook(token: string, webhookId: string): Promise<void> {
    await this.request(token, 'DELETE', `${this.settings.baseUrl}/webhooks/${encodeURIComponent(webhookId)}`, undefined, true);
  }

  private async collect<T extends z.ZodType>(token: string, firstUrl: string, item: T): Promise<z.infer<T>[]> {
    const rows: z.infer<T>[] = [];
    let url: string | null = firstUrl;
    for (let pages = 0; url; pages++) {
      if (pages >= this.settings.maxPages) throw new UpUnavailableError('Up returned more pages than the configured limit');
      const parsed = page(item).parse(await this.request(token, 'GET', url));
      rows.push(...parsed.data);
      url = parsed.links?.next ?? null;
      if (url && new URL(url).origin !== new URL(this.settings.baseUrl).origin) {
        throw new UpUnavailableError('Up pagination link points to another origin; refusing to follow it');
      }
    }
    return rows;
  }

  private async request(token: string, method: string, url: string, body?: unknown, allowNotFound = false): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.settings.requestTimeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new UpUnavailableError('Could not reach Up');
    }
    if (response.status === 401) throw new UpAuthRejectedError();
    if (response.status === 404 && allowNotFound) return null;
    if (!response.ok) throw new UpUnavailableError(`Up answered HTTP ${response.status}`, response.status);
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new UpUnavailableError('Up answered with an unreadable body');
    }
  }
}
