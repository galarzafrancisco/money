/**
 * Domain errors. Services throw these; the REST exception filter and the MCP
 * adapter translate them into transport-specific responses, so both
 * interfaces report the same failures the same way.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly code = 'validation_failed';
  readonly httpStatus = 400;
}

export class NotFoundError extends DomainError {
  readonly code = 'not_found';
  readonly httpStatus = 404;
}

export class ConflictError extends DomainError {
  readonly code = 'conflict';
  readonly httpStatus = 409;
}

/**
 * A change would leave an account's ledger inconsistent: negative cash,
 * selling shares that are not held, or a ticker traded in two currencies.
 */
export class LedgerViolationError extends DomainError {
  readonly code = 'ledger_violation';
  readonly httpStatus = 422;
}

export class UpstreamError extends DomainError {
  readonly code = 'upstream_unavailable';
  readonly httpStatus = 502;
}

/** A feature that this deployment has not been configured for (e.g. a missing encryption key) */
export class NotConfiguredError extends DomainError {
  readonly code = 'not_configured';
  readonly httpStatus = 503;
}

/** The credential a user gave for an external provider was refused */
export class CredentialRejectedError extends DomainError {
  readonly code = 'credential_rejected';
  readonly httpStatus = 422;
}
