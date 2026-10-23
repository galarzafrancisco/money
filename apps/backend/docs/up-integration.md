# Up! integration (read-only)

Money can import a user's own [Up](https://up.com.au) accounts and transactions
for tracking. This is the one approved exception to "no banking integrations"
(see [AGENTS.md](../../../AGENTS.md)). It is **read-only**: Money never makes a
payment or transfer, never changes anything at Up, and has no code path that
could. Figures are tracking aids, not tax advice.

> **Validation status.** Everything here is validated against the
> [`up-bank-mock`](../../../packages/up-mock/README.md) package only. Nothing has
> been run against a real Up account or token. Which behaviours come from Up's
> published documentation and which are guesses is listed in the mock's
> [CONTRACT.md](../../../packages/up-mock/docs/CONTRACT.md). Before relying on
> the integration, do the live checks in [Real Up: operational
> requirements](#real-up-operational-requirements).

## Model: imported records are not ledger records

Imported data lives in its own tables and is never written into `accounts` or
`transactions`. A manual transaction (deposit, withdrawal, buy …) and an Up
transaction are different kinds of thing, and the ledger's transaction types
carry no "imported" flag. Balances, lots, holdings and gains therefore never
include Up data, and the two cannot be double counted by construction.

| Table | Holds |
|---|---|
| `up_integrations` | One per user: status, token (AES-256-GCM ciphertext), webhook ID and secret (ciphertext), last sync and error code |
| `up_accounts` | Imported accounts: Up ID, name, type, ownership, currency, last balance, `visible` (default `false`), optional `linked_account_id` to a Money account, per-account transaction cursor, `removed_at` |
| `up_transactions` | Imported transactions: Up ID, status, amounts (numeric), optional foreign amount, timestamps, `deleted_at` (soft delete), optional `matched_transaction_id` to a manual Money transaction |
| `up_webhook_events` | Authentic events seen: unique per `(integration, event_id)`, attempts, outcome (replay and audit record) |
| `up_sync_runs` | Audit trail of each sync: trigger, counts, error code |

Every row carries `user_id` and every repository method takes it, like the rest
of Money. Another user's resource answers `404`.

**Reconciliation is explicit.** `PUT /api/up/transactions/:id/match` links an
imported transaction to a manual one the user recorded for the same event; the
link is one-to-one. Unmatched imports remain separate records. Linking an Up
account to a Money account (`linkedAccountId`) is a label only. Neither changes
any ledger figure. Provenance is the `source: "up"` field on every returned
record and the `up_*` tables.

## Behaviour

- **Connect** (`POST /api/up/connection`, body `{ token }`): the token must work
  (`GET /accounts`), must not belong to Up accounts already imported by another
  Money user (`409`), and, on reconnect, must belong to the same Up customer as
  the existing import (`409`; disconnect with `purge` to start over). The token is
  stored encrypted, Money's webhook is registered, and a full first sync runs
  before the call answers.
- **First sync**: all accounts, then every page of each account's transactions.
  All accounts start **hidden**.
- **Incremental sync** (`POST /api/up/sync`, and on reconnect): per account,
  re-reads from `txCursor - UP_SYNC_OVERLAP_DAYS` (default 14). Rows are upserts
  keyed by Up ID, so repeats do not duplicate. A transaction we hold inside the
  window that Up no longer returns is marked deleted (`deleted_at`, kept for
  provenance, excluded from lists unless `includeDeleted=true`). An account that
  disappears gets `removed_at`. Concurrent syncs of one integration are
  coalesced into one run.
- **Updates**: a HELD → SETTLED change, or an amount changed at settlement,
  overwrites the imported row. Up's identifier behaviour for that case is not
  verified (see CONTRACT.md); both an update in place and delete + create converge.
- **Webhooks**: see below. Optional: without them everything works with manual
  syncs.
- **Disconnect** (`DELETE /api/up/connection`): deletes Money's webhook at Up
  (best effort), erases the stored token and webhook secret, stops syncing.
  Imported data stays unless `?purge=true`. **Money cannot revoke the token at
  Up: the user should revoke it there too.**
- **Rotation / revoked token**: when Up answers `401`, the integration becomes
  `rejected` (`lastError.code = token_rejected`) and the status carries a hint.
  Imported data stays. Connect again with a new token to recover.
- **Currency**: Up accounts are AUD. A transaction may carry a `foreignAmount`
  with its own currency code. Money stores that as reported and does no FX or
  Australian-dollar conversion of its own. Nothing here claims multi-currency
  accounts at Up.
- **Errors**: `422 credential_rejected`, `502 upstream_unavailable`,
  `503 not_configured` (no `UP_ENCRYPTION_KEY`), `409` conflicts, `404`. Token
  values, response bodies and signatures never appear in errors or logs.

## Webhook receiver

`POST /api/v1/webhooks/up` is **one global endpoint**, not per user, with no
user ID or token in the path. (The provisional `/api/v1/webook` was misspelled
and was never implemented.) Up documents that the URL must be an HTTP(S) URL of
at most 300 characters; Money registers
`$PUBLIC_BASE_URL/api/v1/webhooks/up` (56 characters for production).

Processing order:

1. Parse the body only enough to read the event's webhook ID. Nothing is trusted.
2. Look up the integration by that webhook ID (opaque, issued by Up) and decrypt
   its secret. Compute HMAC-SHA256 of the **raw body** and compare with
   `X-Up-Authenticity-Signature` in constant time. A missing or malformed
   header, unknown webhook, disconnected integration or wrong signature all get
   the identical `401`, with equalised work for unknown IDs.
3. Only then record the event ID in `up_webhook_events` (unique), which gives
   replay protection and idempotency, and act.
4. The event carries IDs, not contents. Money fetches the transaction from Up
   with the user's token and upserts it. A forged or replayed body cannot inject
   data, and out-of-order events converge because each one reads current state.
   `TRANSACTION_DELETED` (or a `404` from Up) soft-deletes. Unknown event types
   are acknowledged and ignored.
5. Answers: `200` processed / duplicate / ignored; `401` authentication failed;
   `400` authentic but malformed; `503` Up could not be reached (Up retries; the
   event is not marked processed, so the retry is processed).

The route is intentionally outside Taico authentication and the session/CSRF
middleware (Up has neither). It is excluded from the OpenAPI spec and generated
client. It needs the raw request body, so the app is created with
`rawBody: true` (`main.ts` and the test app).

### Threat model

| Threat | Mitigation |
|---|---|
| Forged event | HMAC with a per-webhook secret known only to Money and Up; checked before any processing |
| Event for another user | Integration found by webhook ID, secret per integration; a user's secret cannot sign another's events |
| Replay / duplicate delivery | Unique `(integration, event_id)`; a processed event is a no-op |
| Stale or reordered event | Events only trigger a fetch of current state |
| Probing for valid webhook IDs | Uniform `401`, equalised work |
| Database leak | Tokens and webhook secrets are AES-256-GCM encrypted with `UP_ENCRYPTION_KEY`; the row ID is bound as associated data |
| Token in transit/logs | Sent only in the `Authorization` header to the configured Up base URL; redirects are refused; pagination links on another origin are refused; no token in URLs, logs or errors |
| Resource exhaustion | `UP_MAX_PAGES` bounds a sync; body size is the Express default |
| Money used to act on the bank | No code calls any mutating Up endpoint except creating/deleting Money's own webhook |

## REST and MCP

Both call `UpService`. MCP servers are built per request from the token's user,
and the webhook path holds no MCP server, so no state is retained between
requests (the only in-memory state is the per-integration sync-coalescing map in
`UpSyncService`, which is a performance guard and not business state).

| REST (`/api/up/…`) | MCP tool | Purpose |
|---|---|---|
| `GET status` | `get_up_status` | Connection status and visible/hidden counts |
| `POST connection` | `connect_up` | Connect or reconnect with a token |
| `DELETE connection?purge=` | `disconnect_up` | Disconnect |
| `POST sync` | `sync_up` | Sync now |
| `GET sync-runs` | `list_up_sync_runs` | Last 20 syncs |
| `GET accounts?visibility=` | `list_up_accounts` | `visible` (default), `hidden`, `all` |
| `PUT accounts/visibility` | `set_up_account_visibility` | Make exactly these accounts visible |
| `PATCH accounts/:id` | `update_up_account` | Show/hide one, link to a Money account |
| `GET transactions` | `list_up_transactions` | Paged; see below |
| `PUT/DELETE transactions/:id/match` | `match_up_transaction` / `unmatch_up_transaction` | Reconcile with a manual transaction |

## Frontend contract (Accounts UI)

The UI is built: **Connections** (`/connections`: token entry, account selection, category, sync, disconnect) and an "Up accounts (imported)" card on the Accounts page, in `apps/web/src/features/connections`. Each Up account can carry a Money category (`categoryId` on `updateUpAccount`; cleared if the category is deleted). It uses the generated
client (`money.up.*`, tag `up`). Rules:

1. **Default-hidden.** After `connectUp`, every imported account is hidden.
   `getUpStatus().accounts` gives `{ total, visible, hidden }` and `hint` says
   when the user still has to choose. Show a selection step listing
   `listUpAccounts({ visibility: 'all' })` and save it with
   `setUpAccountVisibility({ visibleAccountIds })` (exactly the ticked ones; the
   rest become hidden).
2. **Default views** use `listUpAccounts()` and `listUpTransactions()` with no
   `visibility`: visible accounts only.
3. **"Show all"** is a deliberate control: `visibility=all` (or `hidden`) on both
   lists. **Per-account show all**: `listUpTransactions({ accountId })` returns
   that account's transactions even when it is hidden. Hidden accounts keep
   syncing; never present them as missing or deleted.
   **Reports and dashboard** (accounts report, categories report, dashboard,
   account groups) include imported accounts as top-level cash accounts at the
   balance Up last reported, once each. `visibility` (`visible` by default,
   `hidden`, `all`) selects which imported accounts; `rootAccountId` resolves
   any imported account, hidden or not. Imported balances are never added to a
   manual account's own figures.
4. **Provenance.** Label every imported record with its `source: "up"` and
   keep it visually distinct from manual accounts and transactions. Do not add
   imported amounts to manual balances, holdings or gains. `reconciliation` is
   `matched` or `unmatched`; `matchedTransactionId` points at the manual record.
5. **Transactions** are paged: pass `limit` (≤ 500) and `offset`; `nextOffset`
   is `null` on the last page. `status` is `HELD` or `SETTLED`; show HELD as
   pending. `includeDeleted=true` lists those Up deleted (`deletedAt` set).
   Amounts are decimal strings (negative = money out).
6. **States** from `getUpStatus`: `none` (offer connect), `active`, `rejected`
   (show `lastError` and ask for a new token), `disconnected`. `configured:
   false` or a `503 not_configured` means the server has no encryption key.
   `webhookStatus: failed` means live updates are off; "Sync now" still works.
   Token entry is a password-style field, sent once, never shown or stored in
   the browser; tell the user to revoke it at Up when disconnecting.
7. Mutating calls from the browser use the session cookie with `X-CSRF-Token`
   as for the rest of `/api`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `UP_ENCRYPTION_KEY` | random per process outside production; **none in production** | 32 bytes, base64 (`openssl rand -base64 32`). Without it in production the import answers `503`. With a per-process dev key, stored tokens stop decrypting on restart (reconnect) |
| `UP_API_BASE_URL` | `https://api.up.com.au/api/v1` | Tests and development point it at `up-bank-mock` |
| `UP_REGISTER_WEBHOOK` | `true` when `PUBLIC_BASE_URL` is https, else `false` | Whether connect registers Money's webhook at Up |
| `UP_PAGE_SIZE` | `100` | Up caps at 100 |
| `UP_MAX_PAGES` | `500` | Paging-loop guard per list per sync |
| `UP_SYNC_OVERLAP_DAYS` | `14` | Re-read window before each account's cursor |
| `UP_REQUEST_TIMEOUT_MS` | `15000` | Per request |

## Development with the mock

The mock is a workspace package (`up-bank-mock`), used by the backend tests
(`src/up.e2e.spec.ts`) over real HTTP, with its webhook deliveries routed into
the app under test. To try it by hand:

```bash
npx -w up-bank-mock up-bank-mock          # prints the API URL and a sample token
UP_API_BASE_URL=http://127.0.0.1:<port>/api/v1 npm run dev
```

then connect with the printed token (see the package README). The mock never
contacts the internet.

## Real Up: operational requirements

Separate from mock development. None of this has been done.

1. Provision the `money-up` Secret with `UP_ENCRYPTION_KEY` in spark-ops (the
   manifest references it as optional) and back it up with the database.
2. Confirm outbound HTTPS from the pod to `api.up.com.au`.
3. Confirm Up can reach `https://money.american-broomstick.com/api/v1/webhooks/up`
   and that the route is exempt from any ingress auth.
4. With a real **read-only** personal token of the owner: connect, check account
   and transaction shapes, the real webhook event body and signature encoding,
   what `PING` looks like, retry/timeout behaviour, whether a settlement
   changes a transaction's ID, and the webhook count limit. Record results and
   correct CONTRACT.md and the code if they differ.
5. Rotating `UP_ENCRYPTION_KEY` makes stored tokens unreadable (status
   `token_unreadable`): users reconnect.
6. Monitor `up_sync_runs` and `lastError` for `token_rejected` and
   `upstream_unavailable`.
