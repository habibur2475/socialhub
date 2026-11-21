/**
 * Response contracts.
 *
 * Response shapes are types rather than schemas: the server is the authority that
 * produces them (`satisfies` at the controller enforces the match), and the
 * browser only needs to read them. Validating responses at runtime in the client
 * would cost CPU on every request to catch a bug that a compiler already catches.
 */

import type { ErrorCode } from '@socialhub/kernel';

export type AccountType = 'USER' | 'STAFF' | 'ROOT';

export type AuthUser = {
  readonly id: string;
  readonly accountType: AccountType;
  readonly permissions: readonly string[];
};

export type SessionResponse = {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
  readonly user: AuthUser;
};

export type RegisteredResponse = {
  readonly verificationRequired: boolean;
  readonly message: string;
};

export type VerifyEmailResponse = {
  readonly activated: boolean;
};

/** Returned by both `/me` and the two password endpoints' siblings. */
export type CurrentUserResponse = AuthUser;

export type MessageResponse = {
  readonly message: string;
};

/** The one error shape every endpoint can return. */
export type ApiErrorBody = {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly traceId: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
};

export type ValidationIssue = {
  /** Dotted path to the offending field, empty for a whole-object failure. */
  readonly path: string;
  readonly message: string;
};

/**
 * Narrows the `details` of a `VALIDATION_FAILED` response.
 *
 * Field errors are what a form needs to place a message under the right input,
 * so this is a typed accessor rather than a cast at every call site.
 */
export const validationIssuesOf = (body: ApiErrorBody): readonly ValidationIssue[] => {
  const issues = body.error.details?.['issues'];
  if (!Array.isArray(issues)) return [];

  return issues.flatMap((issue: unknown) => {
    if (typeof issue !== 'object' || issue === null) return [];
    const record = issue as Record<string, unknown>;
    const path = typeof record['path'] === 'string' ? record['path'] : '';
    const message = typeof record['message'] === 'string' ? record['message'] : 'Invalid value';
    return [{ path, message }];
  });
};
