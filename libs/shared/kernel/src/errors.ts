/**
 * Domain error taxonomy.
 *
 * Every error that crosses a process boundary is one of these codes: the HTTP
 * layer maps them to status codes, the logger maps them to alert levels, and the
 * client maps them to user-facing copy. Codes are stable API surface — renaming
 * one is a breaking change.
 */

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'TOKEN_REUSE_DETECTED',
  'FORBIDDEN',
  'ACCOUNT_LOCKED',
  'ACCOUNT_SUSPENDED',
  'EMAIL_NOT_VERIFIED',
  'MFA_REQUIRED',
  'MFA_INVALID_CODE',
  'MFA_ALREADY_ENABLED',
  'RATE_LIMITED',
  'NOT_FOUND',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type AppError = {
  readonly code: ErrorCode;
  /** Safe to show to an end user; never contains internal detail or PII. */
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
  /** Trace correlation id, attached by the framework layer. */
  readonly traceId?: string;
};

export const appError = (
  code: ErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError => (details === undefined ? { code, message } : { code, message, details });
