import { moneyErrorOf } from '@money/client';
import type { ReactNode } from 'react';
import { Callout } from '../../ui';

const TITLES: Record<string, string> = {
  validation_failed: 'Check the details',
  not_found: 'Not found',
  conflict: 'That conflicts with other records',
  ledger_violation: 'The account history does not allow this',
  upstream_unavailable: 'A price source is unavailable',
  credential_rejected: 'Up did not accept that token',
  not_configured: 'Not available on this server',
  csrf_failed: 'Please try again',
  session_expired: 'Your session ended',
  auth_unavailable: 'Sign-in service unavailable, try again shortly',
};

/** The user-facing message of a failed call: Money's error.message, or a generic fallback */
export function errorMessage(error: unknown): string {
  const failure = moneyErrorOf(error);
  if (failure) return failure.message;
  if (error instanceof TypeError) return 'Could not reach Money. Check your connection and try again.';
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function errorCode(error: unknown): string | null {
  return moneyErrorOf(error)?.code ?? null;
}

/** Feature-level display of an expected API failure, keyed off error.code (guidelines §6.4) */
export function ApiErrorCallout({ error, title, children }: { error: unknown; title?: string; children?: ReactNode }) {
  if (!error) return null;
  const code = errorCode(error);
  return (
    <Callout tone="danger" title={title ?? (code && TITLES[code]) ?? 'Something went wrong'}>
      {errorMessage(error)}
      {children}
    </Callout>
  );
}
