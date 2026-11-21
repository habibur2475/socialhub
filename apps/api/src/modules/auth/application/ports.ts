/**
 * Ports — the application layer's view of the outside world.
 *
 * The service depends on these interfaces, never on concrete repositories. That
 * is what makes the flows testable without a database and lets the persistence
 * strategy change without touching a single business rule.
 */

import type { AccountState, AccountType } from '@socialhub/kernel';

export type AccountRecord = {
  readonly id: string;
  readonly accountType: AccountType;
  readonly state: AccountState;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly phone: string | null;
  readonly passwordHash: string | null;
  readonly mfaEnabledAt: Date | null;
  readonly sessionEpoch: number;
  readonly failedLoginCount: number;
  readonly lockedUntil: Date | null;
  readonly createdAt: Date;
};

export type AccountStore = {
  /** Returns null when the email is already taken; the unique index is the arbiter. */
  create(input: {
    id: string;
    accountType: AccountType;
    state: AccountState;
    email: string;
    passwordHash: string;
    username: string;
    displayName: string;
  }): Promise<AccountRecord | null>;
  findById(id: string): Promise<AccountRecord | null>;
  findByEmail(email: string): Promise<AccountRecord | null>;
  emailExists(email: string): Promise<boolean>;
  registerFailedLogin(id: string, threshold: number, lockForSeconds: number): Promise<number>;
  registerSuccessfulLogin(id: string, at: Date): Promise<void>;
  markEmailVerified(id: string): Promise<void>;
  replacePasswordHash(id: string, hash: string): Promise<void>;
};

export type SessionStore = {
  create(input: {
    id: string;
    accountId: string;
    expiresAt: Date;
    userAgent: string | null;
    ipHash: string | null;
  }): Promise<void>;
  findLive(id: string): Promise<{ id: string; accountId: string; expiresAt: Date } | null>;
  revoke(id: string, reason: string): Promise<void>;
  revokeAllForAccount(accountId: string, reason: string): Promise<number>;
  touch(id: string): Promise<void>;
};

export type RefreshTokenStore = {
  insert(input: {
    id: string;
    sessionId: string;
    accountId: string;
    familyId: string;
    parentId: string | null;
    sessionEpoch: number;
    digest: Buffer;
    expiresAt: Date;
  }): Promise<void>;
  findByDigest(digest: Buffer): Promise<{
    id: string;
    sessionId: string;
    accountId: string;
    familyId: string;
    sessionEpoch: number;
    expiresAt: Date;
    consumedAt: Date | null;
    revokedAt: Date | null;
  } | null>;
  consume(id: string): Promise<boolean>;
  revokeFamily(familyId: string): Promise<number>;
};

export type OneTimeCodeStore = {
  issue(input: {
    id: string;
    accountId: string;
    purpose: string;
    channel: 'EMAIL' | 'SMS';
    destinationHash: Buffer;
    codeDigest: Buffer;
    expiresAt: Date;
    maxAttempts: number;
  }): Promise<void>;
  findLatest(
    accountId: string,
    purpose: string,
  ): Promise<{
    id: string;
    codeDigest: Buffer;
    attempts: number;
    maxAttempts: number;
    expiresAt: Date;
    consumedAt: Date | null;
  } | null>;
  recordAttempt(id: string): Promise<void>;
  consume(id: string): Promise<boolean>;
};

export type Clock = () => Date;

export type IdGenerator = {
  next(): string;
};

export type MailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
};

export type Mailer = {
  send(message: MailMessage): Promise<void>;
};

export type AuditEvent = {
  readonly action: string;
  readonly actorId: string | null;
  readonly actorType: AccountType | null;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly outcome: 'SUCCESS' | 'DENIED' | 'ERROR';
  readonly ipHash: string | null;
  readonly userAgent: string | null;
  readonly traceId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type AuditSink = {
  record(event: AuditEvent): Promise<void>;
};

export type PasswordService = {
  hash(password: string): Promise<string>;
  verify(digest: string, password: string): Promise<boolean>;
  needsRehash(digest: string): boolean;
};

export type AccessTokenIssuer = {
  issue(input: {
    accountId: string;
    accountType: AccountType;
    sessionId: string;
    sessionEpoch: number;
  }): Promise<{ token: string; expiresAt: Date }>;
  verify(token: string): Promise<{
    accountId: string;
    accountType: AccountType;
    sessionId: string;
    sessionEpoch: number;
    expiresAt: Date;
  } | null>;
};

export type LoginThrottle = {
  /** Returns false when the identity has exhausted its attempt budget. */
  tryConsume(key: string): Promise<boolean>;
  reset(key: string): Promise<void>;
};
