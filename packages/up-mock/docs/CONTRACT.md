# Contract: verified Up behaviour vs emulation choices

Source for "documented": the public Up API documentation at
<https://developer.up.com.au/>, read on 2026-10-22. That read covered
authentication, pagination, transaction filters, the account and transaction
attributes, errors and the *Create webhook* section. The page text available
for that read was truncated before *Handling webhook events*, the event types
and the logs section, so those are marked **recalled, not re-verified**.

**This mock has never been compared against the live service.** Treat anything
below that is not "documented" as a hypothesis to validate with a real
(read-only) token before relying on it.

## Documented by Up (verified in the docs read above)

- Base path `/api/v1`; `Authorization: Bearer <token>`; missing, malformed or invalid tokens → `401`.
- Error body: `{ "errors": [{ "status", "title", "detail", "source"?: { "parameter" | "pointer" } }] }`.
- Pagination: `page[size]` positive integer, generally capped at 100; `links.prev`/`links.next` are `null` when absent; clients must follow the links.
- Transactions are ordered newest first. Filters: `filter[status]` (`HELD`/`SETTLED`), `filter[since]`, `filter[until]` (RFC 3339), `filter[category]`, `filter[tag]`. The filters should not be used for pagination.
- Account attributes: `displayName`, `accountType` (`SAVER`/`TRANSACTIONAL`/`HOME_LOAN`), `ownershipType` (`INDIVIDUAL`/`JOINT`), `balance { currencyCode, value, valueInBaseUnits }`, `createdAt`.
- Transaction attributes: `status`, `rawText`, `description`, `message`, `isCategorizable`, `holdInfo`, `roundUp`, `cashback`, `amount`, `foreignAmount`, `cardPurchaseMethod`, `settledAt`, `createdAt`, `transactionType`, `note`, `performingCustomer`, `deepLinkURL`.
- `POST /webhooks`: URL must be a valid HTTP or HTTPS URL of at most 300 characters; optional description of at most 64 characters; `201`; at most 10 webhooks at once; `secretKey` is returned only on creation; list is oldest first.
- Delivery: the receiver must answer `200`; delivery is retried with exponential backoff when the URL is unreachable or does not answer `200`.
- Signature: header `X-Up-Authenticity-Signature` is the SHA-256 HMAC of the raw request body keyed by the webhook's `secretKey`.

## Recalled, not re-verified

- Event types `TRANSACTION_CREATED`, `TRANSACTION_SETTLED`, `TRANSACTION_DELETED`, `PING`.
- Event body: `{ data: { type: "webhook-events", id, attributes: { eventType, createdAt }, relationships: { webhook, transaction? } } }`. The event carries the transaction's ID, not its contents: a receiver must fetch the transaction.
- Signature encoding (hex digest).
- Delivery log resource shape and statuses `DELIVERED` / `UNDELIVERABLE` / `BAD_RESPONSE_CODE`.
- `POST /webhooks/{id}/ping` creates a `PING` event; `GET /util/ping`.

## Emulation choices (not claims about Up)

- Default page size 30; `page[size]` outside 1–100 → `400`.
- `filter[since]` is inclusive and `filter[until]` exclusive.
- The cursor in `links.next` is `page[after]` = base64url offset. Up's cursors are different and opaque.
- Retry schedule: `retryDelaysMs` (default 50/100/200 ms, four attempts). Up's real schedule, attempt count and timeout are unknown here.
- Only an exact `200` is treated as success (documented), anything else retries.
- A held transaction settling with a different amount keeps the same ID in the mock. Whether the real service issues a new ID (a `TRANSACTION_DELETED` followed by `TRANSACTION_CREATED`) is **not verified**; consumers should handle both.
- Webhook secrets are deterministic (`mock-secret-<suffix>`), unlike Up's.
- `deliveryHosts` loopback restriction, customers/tokens model, the `/__mock__/` admin routes and fixtures are testing aids with no Up counterpart.
- No categories or tags endpoints, no attachments, no `HOME_LOAN` fixtures, a single currency per account (foreign amounts only as `foreignAmount` on a transaction).

## Not emulated

Rate limits, attachments, categories/tags management, the `/util/ping` auth semantics, payment initiation of any kind (Up's API has none that this mock needs; the mock exposes none).
