/**
 * Money's REST API client. Everything under ./generated is produced at build
 * time by @taico/openapi-sdkgen from apps/backend/openapi.json; do not edit
 * it (docs/architecture/api-clients.md). This file only re-exports it and adds
 * a reader for Money's error envelope.
 */
export * from './generated/index.js';
export { ApiError } from './generated/base-client.js';
import { ApiError } from './generated/base-client.js';

/** Money's REST error envelope: { error: { code, message, details } } */
export type MoneyErrorBody = { code: string; message: string; details?: Record<string, unknown> };

/**
 * The `error` part of a failed Money request, or null when the failure is not
 * a Money API error (network failure, aborted request, programming error).
 */
export function moneyErrorOf(error: unknown): (MoneyErrorBody & { status: number }) | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { error?: Partial<MoneyErrorBody> } | undefined;
  const inner = body?.error;
  if (inner && typeof inner.code === 'string') {
    return { status: error.status, code: inner.code, message: typeof inner.message === 'string' ? inner.message : error.message, details: inner.details };
  }
  return { status: error.status, code: `http_${error.status}`, message: error.message };
}
