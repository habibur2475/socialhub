/**
 * The single place where domain error codes become HTTP statuses.
 *
 * Keeping this mapping central means a new error code cannot accidentally ship
 * as a 200 or a 500, and the client contract stays in one reviewable file.
 */

import type { ErrorCode } from '@socialhub/kernel';

export const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  SESSION_EXPIRED: 401,
  SESSION_REVOKED: 401,
  TOKEN_REUSE_DETECTED: 401,
  FORBIDDEN: 403,
  ACCOUNT_LOCKED: 423,
  ACCOUNT_SUSPENDED: 423,
  EMAIL_NOT_VERIFIED: 403,
  MFA_REQUIRED: 401,
  MFA_INVALID_CODE: 401,
  MFA_ALREADY_ENABLED: 409,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export const statusFor = (code: ErrorCode): number => STATUS_BY_CODE[code];
