# up-bank-mock

A deterministic, **offline** mock of the read-only parts of the [Up](https://developer.up.com.au/)
API and its webhooks, for development and automated tests. It is not affiliated
with Up, never contacts Up, and needs no real credentials.

It has no dependencies and knows nothing about any particular application.

```ts
import { createUpMock } from 'up-bank-mock';

const mock = createUpMock({ retryDelaysMs: [1, 1] });
mock.addCustomer('up:test:token'); // fictional accounts + 80 transactions
const baseUrl = await mock.listen(); // http://127.0.0.1:<port>/api/v1

// ...point your client at baseUrl with `Authorization: Bearer up:test:token`...

const hook = mock.createWebhook('up:test:token', 'http://127.0.0.1:3000/hooks');
mock.addTransaction('up:test:token', { accountId, description: 'Coffee', amountInBaseUnits: -450 });
await mock.idle(); // webhook delivered (signed), retried on non-200
await mock.close();
```

## What it emulates

| Area | Endpoints / behaviour |
|---|---|
| Auth | `Authorization: Bearer <token>`; missing/unknown/revoked token → `401` in Up's error shape |
| Accounts | `GET /accounts`, `GET /accounts/{id}` |
| Transactions | `GET /transactions`, `GET /accounts/{id}/transactions`, `GET /transactions/{id}`; `filter[status]`, `filter[since]`, `filter[until]`, `filter[category]`, `filter[tag]`; newest first |
| Pagination | `page[size]` (1–100), `links.prev` / `links.next` opaque URLs |
| Webhooks | `POST/GET /webhooks`, `GET/DELETE /webhooks/{id}`, `POST /webhooks/{id}/ping`, `GET /webhooks/{id}/logs`; `secretKey` returned only on creation |
| Delivery | `X-Up-Authenticity-Signature` = hex HMAC-SHA256 of the raw body; only `200` counts as success; retried with backoff; delivery log per attempt |
| Events | `TRANSACTION_CREATED`, `TRANSACTION_SETTLED`, `TRANSACTION_DELETED`, `PING` |
| Test control | add/settle/delete transactions, revoke/rotate tokens, `autoDeliver: false` + `flush(order)` for out-of-order, `redeliver()` for duplicates, `failNextDeliveries()` |

**Safety:** webhook deliveries are only sent to loopback hosts unless you list
others in `deliveryHosts`. The mock never calls any other address.

Which of this is documented Up behaviour and which is an emulation choice is
spelled out in [docs/CONTRACT.md](docs/CONTRACT.md). Read it before trusting the
mock as evidence about the real service.

## Standalone server

`npx up-bank-mock --port 4190 --token up:mock:demo-token` serves the API (with
the `/__mock__/` admin routes enabled) for manual development.

## Determinism

IDs are counters in UUID shape, fixture data comes from a seeded generator and
starts at 2026-01-01. The same calls in the same order give the same data.

## Scripts

`npm test` compiles and runs the tests (`node:test`); `npm run build` emits `dist/`.
See [docs/PUBLISHING.md](docs/PUBLISHING.md) for publication readiness.
