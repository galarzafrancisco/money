import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createUpMock, SIGNATURE_HEADER, signBody, verifySignature, type UpMock } from './index';

const TOKEN = 'up:test:one';

async function api(mock: UpMock, path: string, init: { token?: string | null; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  if (init.body) headers['content-type'] = 'application/json';
  const url = path.startsWith('http') ? path : `${mock.baseUrl}${path}`;
  const res = await fetch(url, { method: init.method ?? 'GET', headers, body: init.body ? JSON.stringify(init.body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('read API', () => {
  let mock: UpMock;
  before(async () => {
    mock = createUpMock();
    mock.addCustomer(TOKEN);
    mock.addCustomer('up:test:two', { fixtures: { spendingTransactions: 3 } });
    await mock.listen();
  });
  after(() => mock.close());

  it('rejects missing, unknown and revoked tokens with 401 and the Up error shape', async () => {
    assert.equal((await api(mock, '/util/ping', { token: null })).status, 401);
    const bad = await api(mock, '/accounts', { token: 'nope' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.errors[0].title, 'Not Authorized');
    mock.revokeToken('up:test:two');
    assert.equal((await api(mock, '/accounts', { token: 'up:test:two' })).status, 401);
    mock.restoreToken('up:test:two');
    assert.equal((await api(mock, '/accounts', { token: 'up:test:two' })).status, 200);
  });

  it('lists accounts with Up attribute names and money in base units', async () => {
    const { body } = await api(mock, '/accounts');
    assert.equal(body.data.length, 3);
    const spending = body.data[0];
    assert.equal(spending.type, 'accounts');
    assert.equal(spending.attributes.accountType, 'TRANSACTIONAL');
    assert.equal(typeof spending.attributes.balance.valueInBaseUnits, 'number');
    assert.match(spending.attributes.balance.value, /^-?\d+\.\d{2}$/);
  });

  it('paginates transactions newest first by following links.next', async () => {
    let next: string | null = `${mock.baseUrl}/transactions?page[size]=20`;
    const ids: string[] = [];
    let pages = 0;
    let last = Infinity;
    while (next) {
      const { body } = await api(mock, next);
      pages++;
      for (const t of body.data) {
        ids.push(t.id);
        const created = Date.parse(t.attributes.createdAt);
        assert.ok(created <= last);
        last = created;
      }
      next = body.links.next;
    }
    assert.ok(pages >= 4);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, mock.transactionsOf(TOKEN).length);
  });

  it('filters by status, since/until, account and validates page size', async () => {
    const held = mock.addTransaction(TOKEN, { accountId: mock.accountsOf(TOKEN)[0].id, description: 'Hold', amountInBaseUnits: -100, status: 'HELD', createdAt: '2030-01-01T00:00:00Z' });
    const heldList = await api(mock, '/transactions?filter[status]=HELD');
    assert.deepEqual(heldList.body.data.map((t: any) => t.id), [held.id]);
    const since = await api(mock, '/transactions?filter[since]=2029-01-01T00:00:00Z');
    assert.equal(since.body.data.length, 1);
    const until = await api(mock, '/transactions?filter[until]=2029-01-01T00:00:00Z&page[size]=100');
    assert.equal(until.body.data.length, 80);
    const account = await api(mock, `/accounts/${mock.accountsOf(TOKEN)[1].id}/transactions`);
    assert.equal(account.body.data.length, 2);
    assert.equal((await api(mock, '/transactions?page[size]=101')).status, 400);
    assert.equal((await api(mock, '/transactions?filter[status]=BOGUS')).status, 400);
    assert.equal((await api(mock, '/transactions?filter[since]=yesterday')).status, 400);
    mock.deleteTransaction(TOKEN, held.id);
  });

  it('isolates customers', async () => {
    const mine = mock.accountsOf(TOKEN)[0];
    assert.equal((await api(mock, `/accounts/${mine.id}`, { token: 'up:test:two' })).status, 404);
    const other = await api(mock, '/transactions?page[size]=100', { token: 'up:test:two' });
    assert.equal(other.body.data.length, 3 + 1 + 1 + 2 + 1 - 0);
  });

  it('is deterministic for the same creation order', () => {
    const a = createUpMock();
    const b = createUpMock();
    a.addCustomer('t');
    b.addCustomer('t');
    assert.deepEqual(a.transactionsOf('t'), b.transactionsOf('t'));
  });
});

describe('webhooks', () => {
  let mock: UpMock;
  let receiver: Server;
  let receiverUrl: string;
  let received: { body: string; signature: string | undefined }[];
  let respondWith = 200;

  before(async () => {
    received = [];
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ body: Buffer.concat(chunks).toString(), signature: req.headers[SIGNATURE_HEADER.toLowerCase()] as string | undefined });
        res.writeHead(respondWith).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as any).port}/hook`;
    mock = createUpMock({ retryDelaysMs: [1, 1], autoDeliver: false });
    mock.addCustomer(TOKEN, { fixtures: { spendingTransactions: 2 } });
    await mock.listen();
  });
  after(async () => {
    await mock.close();
    receiver.close();
  });

  it('registers, lists, shows the secret once, and deletes', async () => {
    const created = await api(mock, '/webhooks', { method: 'POST', body: { data: { attributes: { url: receiverUrl, description: 'test' } } } });
    assert.equal(created.status, 201);
    assert.ok(created.body.data.attributes.secretKey);
    const listed = await api(mock, '/webhooks');
    assert.equal(listed.body.data.length, 1);
    assert.equal(listed.body.data[0].attributes.secretKey, undefined);
    assert.equal((await api(mock, '/webhooks', { method: 'POST', body: { data: { attributes: { url: 'ftp://x' } } } })).status, 422);
    assert.equal((await api(mock, '/webhooks', { method: 'POST', body: { data: { attributes: { url: 'https://x/' + 'a'.repeat(300) } } } })).status, 422);
    const second = await api(mock, '/webhooks', { method: 'POST', body: { data: { attributes: { url: receiverUrl } } } });
    assert.equal((await api(mock, `/webhooks/${second.body.data.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(mock, `/webhooks/${second.body.data.id}`)).status, 404);
  });

  it('delivers signed events; the signature verifies against the raw body', async () => {
    const [hook] = mock.webhooksOf(TOKEN);
    const tx = mock.addTransaction(TOKEN, { accountId: mock.accountsOf(TOKEN)[0].id, description: 'Event', amountInBaseUnits: -500 });
    assert.equal(mock.pending.length, 1);
    await mock.flush();
    const last = received.at(-1)!;
    assert.ok(verifySignature(last.body, hook.secretKey, last.signature));
    assert.equal(last.signature, signBody(last.body, hook.secretKey));
    assert.equal(verifySignature(last.body + ' ', hook.secretKey, last.signature), false);
    const event = JSON.parse(last.body).data;
    assert.equal(event.type, 'webhook-events');
    assert.equal(event.attributes.eventType, 'TRANSACTION_CREATED');
    assert.equal(event.relationships.transaction.data.id, tx.id);
    assert.equal(event.relationships.webhook.data.id, hook.id);
    assert.equal(mock.deliveries.at(-1)!.deliveryStatus, 'DELIVERED');
  });

  it('retries non-200 responses with backoff, then stops, and logs each attempt', async () => {
    respondWith = 500;
    const before = mock.deliveries.length;
    mock.addTransaction(TOKEN, { accountId: mock.accountsOf(TOKEN)[0].id, description: 'Retry', amountInBaseUnits: -1 });
    await mock.flush();
    const attempts = mock.deliveries.slice(before);
    assert.deepEqual(attempts.map((d) => [d.attempt, d.deliveryStatus]), [[1, 'BAD_RESPONSE_CODE'], [2, 'BAD_RESPONSE_CODE'], [3, 'BAD_RESPONSE_CODE']]);
    assert.equal(new Set(attempts.map((d) => d.eventId)).size, 1);
    respondWith = 200;
  });

  it('injects failures and recovers on a later attempt', async () => {
    const before = mock.deliveries.length;
    mock.failNextDeliveries(1, 503);
    mock.addTransaction(TOKEN, { accountId: mock.accountsOf(TOKEN)[0].id, description: 'Flaky', amountInBaseUnits: -1 });
    await mock.flush();
    assert.deepEqual(mock.deliveries.slice(before).map((d) => d.deliveryStatus), ['BAD_RESPONSE_CODE', 'DELIVERED']);
  });

  it('redelivers the same event id (duplicate) and can reorder (out of order)', async () => {
    const before = received.length;
    const account = mock.accountsOf(TOKEN)[0].id;
    const tx = mock.addTransaction(TOKEN, { accountId: account, description: 'Hold', amountInBaseUnits: -700, status: 'HELD' });
    mock.settleTransaction(TOKEN, tx.id);
    await mock.flush((events) => events.reverse());
    const types = received.slice(before).map((r) => JSON.parse(r.body).data.attributes.eventType);
    assert.deepEqual(types, ['TRANSACTION_SETTLED', 'TRANSACTION_CREATED']);
    const firstId = JSON.parse(received.at(-1)!.body).data.id;
    await mock.redeliver(firstId);
    assert.equal(JSON.parse(received.at(-1)!.body).data.id, firstId);
  });

  it('emits PING and delete events and serves delivery logs', async () => {
    const [hook] = mock.webhooksOf(TOKEN);
    const ping = await api(mock, `/webhooks/${hook.id}/ping`, { method: 'POST' });
    assert.equal(ping.status, 201);
    const tx = mock.addTransaction(TOKEN, { accountId: mock.accountsOf(TOKEN)[0].id, description: 'Gone', amountInBaseUnits: -9, status: 'HELD', emit: false });
    mock.deleteTransaction(TOKEN, tx.id);
    await mock.flush();
    const types = mock.events.slice(-2).map((e) => e.eventType);
    assert.deepEqual(types, ['PING', 'TRANSACTION_DELETED']);
    const logs = await api(mock, `/webhooks/${hook.id}/logs`);
    assert.ok(logs.body.data.length > 0);
    assert.equal(logs.body.data[0].type, 'webhook-delivery-logs');
  });

  it('never delivers outside loopback by default', async () => {
    const outside = createUpMock({ retryDelaysMs: [], autoDeliver: false, fetch: (() => { throw new Error('network used'); }) as any });
    outside.addCustomer('t');
    outside.createWebhook('t', 'https://example.invalid/hook');
    outside.addTransaction('t', { accountId: outside.accountsOf('t')[0].id, description: 'x', amountInBaseUnits: 1 });
    await outside.flush();
    assert.equal(outside.deliveries[0].deliveryStatus, 'UNDELIVERABLE');
  });
});
