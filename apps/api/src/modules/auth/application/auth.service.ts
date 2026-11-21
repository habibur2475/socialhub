/**
 * Authentication use cases.
 *
 * Every flow is expressed as: validate input → load state → decide → persist →
 * emit audit. Failures never reveal whether an account exists, and every
 * expensive branch (hashing, digesting) runs in constant shape so response time
 * cannot be used as an oracle.
 *
 * Notable decisions:
 *   * Registration always succeeds from the client's point of view, even when
 *     the email is taken. The caller receives the usual "check your inbox"
 *     response; the owner of the mailbox gets a "someone tried to register"
 *     notice instead. This removes the account-enumeration channel entirely.
 *   * Login performs a dummy password verification when the account is absent so
 *     that response latency does not reveal existence.
 *   * Refresh rotation marks the presented token consumed and issues a child in
 *     the same family. Presenting an already-consumed token revokes the family,
 *     because that can only mean the token leaked.
 */

import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type AccountType,
  canAuthenticate,
  type Permission,
  PermissionMask,
  appError,
  type AppError,
} from '@socialhub/kernel';

import type { Env } from '../../../config/env.js';
import { evaluatePassword } from '../domain/password-policy.js';
import {
  checkOtp,
  digestOtp,
  generateOtpCode,
  maskDestination,
  type OtpPurpose,
} from '../domain/one-time-code.js';
import {
  isWellFormedRefreshToken,
  mintRefreshToken,
  type RefreshTokenMaterial,
} from '../domain/token.js';
import type {
  AccessTokenIssuer,
  AccountRecord,
  AccountStore,
  AuditSink,
  Clock,
  IdGenerator,
  LoginThrottle,
  Mailer,
  OneTimeCodeStore,
  PasswordService,
  RefreshTokenStore,
  SessionStore,
} from './ports.js';

export type AuthOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AppError };

const ok = <T>(value: T): AuthOutcome<T> => ({ ok: true, value });
const fail = (error: AppError): AuthOutcome<never> => ({ ok: false, error });

/** Everything the requester's context contributes; kept explicit for auditability. */
export type RequestContext = {
  readonly ipHash: string | null;
  readonly userAgent: string | null;
  readonly traceId: string | null;
};

export type RegisterInput = {
  readonly email: string;
  readonly password: string;
  readonly username: string;
  readonly displayName: string;
  readonly context: RequestContext;
};

export type RegistrationResult = {
  /** True when we need the client to complete email verification. */
  readonly verificationRequired: boolean;
};

export type LoginInput = {
  readonly email: string;
  readonly password: string;
  readonly context: RequestContext;
};

export type SessionTokens = {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
};

export type RefreshedSession = {
  readonly accountId: string;
  readonly accountType: AccountType;
  readonly permissions: readonly Permission[];
  readonly session: SessionTokens;
};

export type AuthenticatedSession = {
  readonly accountId: string;
  readonly accountType: AccountType;
  readonly permissions: readonly Permission[];
  readonly session: SessionTokens;
};

export type RefreshInput = {
  readonly refreshToken: string;
  readonly context: RequestContext;
};

const PASSWORD_RESET_PURPOSE: OtpPurpose = 'PASSWORD_RESET';

@Injectable()
export class AuthService {
  public constructor(
    private readonly deps: {
      readonly env: Env;
      readonly accounts: AccountStore;
      readonly sessions: SessionStore;
      readonly refreshTokens: RefreshTokenStore;
      readonly oneTimeCodes: OneTimeCodeStore;
      readonly passwords: PasswordService;
      readonly tokens: AccessTokenIssuer;
      readonly throttle: LoginThrottle;
      readonly mailer: Mailer;
      readonly audit: AuditSink;
      readonly clock: Clock;
      readonly ids: IdGenerator;
      readonly permissionsFor: (accountId: string) => Promise<PermissionMask>;
    },
  ) {}

  /**
   * Registers an external USER account.
   *
   * STAFF and ROOT can never be created through this path: account type is not
   * part of the input, it is a constant here. Internal identities are provisioned
   * by the owner panel with an explicit role and scope assignment.
   */
  public async register(input: RegisterInput): Promise<AuthOutcome<RegistrationResult>> {
    const email = normaliseEmail(input.email);

    const violations = evaluatePassword(input.password, {
      email,
      username: input.username,
      displayName: input.displayName,
      isAdministrative: false,
    });
    if (violations.length > 0) {
      return fail(
        appError('VALIDATION_FAILED', 'Password does not meet the security policy', {
          violations,
        }),
      );
    }

    const passwordHash = await this.deps.passwords.hash(input.password);

    const account = await this.deps.accounts.create({
      id: this.deps.ids.next(),
      accountType: 'USER',
      state: 'PENDING_VERIFICATION',
      email,
      passwordHash,
      username: input.username,
      displayName: input.displayName,
    });

    if (account === null) {
      // Deliberate: indistinguishable from success. The real owner is notified
      // out of band, so the attacker learns nothing from the response.
      await this.deps.mailer.send({
        to: email,
        subject: 'Someone tried to register with your email',
        text: 'A registration attempt used this address. If it was not you, no action is needed.',
      });
      await this.emitAudit('auth.register.duplicate', null, input.context, {
        emailDomain: email.split('@')[1],
      });
      return ok({ verificationRequired: true });
    }

    await this.issueVerificationCode(account, 'EMAIL_VERIFY', input.context);
    await this.emitAudit('auth.register.success', account.id, input.context, {
      accountType: account.accountType,
    });

    return ok({ verificationRequired: true });
  }

  /**
   * Password login.
   *
   * Order is fixed and intentional: throttle → load → verify → state gate →
   * issue. The state gate runs after password verification so that a correct
   * password on a suspended account gets a precise error, while a wrong password
   * on any account gets the same generic error.
   */
  public async login(input: LoginInput): Promise<AuthOutcome<AuthenticatedSession>> {
    const email = normaliseEmail(input.email);
    const throttleKey = `login:${email}`;

    const allowed = await this.deps.throttle.tryConsume(throttleKey);
    if (!allowed) {
      await this.emitAudit('auth.login.throttled', null, input.context, {}, 'DENIED');
      return fail(appError('RATE_LIMITED', 'Too many attempts. Please try again later.'));
    }

    const account = await this.deps.accounts.findByEmail(email);

    if (account === null || account.passwordHash === null) {
      // Equalise timing with a real verification so a missing account and a
      // wrong password take the same wall-clock time.
      await this.deps.passwords.verify(DUMMY_DIGEST, input.password);
      await this.emitAudit(
        'auth.login.failure',
        null,
        input.context,
        { reason: 'unknown_account' },
        'DENIED',
      );
      return fail(appError('INVALID_CREDENTIALS', 'Email or password is incorrect'));
    }

    if (
      account.lockedUntil !== null &&
      account.lockedUntil.getTime() > this.deps.clock().getTime()
    ) {
      await this.emitAudit('auth.login.locked', account.id, input.context, {}, 'DENIED');
      return fail(
        appError('ACCOUNT_LOCKED', 'This account is temporarily locked. Try again later.'),
      );
    }

    const passwordValid = await this.deps.passwords.verify(account.passwordHash, input.password);
    if (!passwordValid) {
      const attempts = await this.deps.accounts.registerFailedLogin(
        account.id,
        this.deps.env.MAX_FAILED_LOGINS,
        this.deps.env.LOCKOUT_SECONDS,
      );
      await this.emitAudit(
        'auth.login.failure',
        account.id,
        input.context,
        { reason: 'invalid_password', attempts },
        'DENIED',
      );
      return fail(appError('INVALID_CREDENTIALS', 'Email or password is incorrect'));
    }

    if (!canAuthenticate(account.state)) {
      await this.emitAudit(
        'auth.login.blocked',
        account.id,
        input.context,
        { state: account.state },
        'DENIED',
      );
      return fail(stateError(account.state));
    }

    // Transparent parameter upgrade: the user has just proven possession, so this
    // is the only moment a rehash can happen without another prompt.
    if (this.deps.passwords.needsRehash(account.passwordHash)) {
      const upgraded = await this.deps.passwords.hash(input.password);
      await this.deps.accounts.replacePasswordHash(account.id, upgraded);
    }

    await this.deps.accounts.registerSuccessfulLogin(account.id, this.deps.clock());
    await this.deps.throttle.reset(throttleKey);

    const session = await this.openSession(account, input.context);
    const permissions = await this.deps.permissionsFor(account.id);

    await this.emitAudit('auth.login.success', account.id, input.context, {
      accountType: account.accountType,
    });

    return ok({
      accountId: account.id,
      accountType: account.accountType,
      permissions: permissions.toList(),
      session,
    });
  }

  /**
   * Exchanges a refresh token for a new access token, rotating the refresh token.
   *
   * The four rejection paths are distinct internally (for alerting) but identical
   * externally: a stolen-token probe learns only that it failed.
   */
  public async refresh(input: RefreshInput): Promise<AuthOutcome<RefreshedSession>> {
    if (!isWellFormedRefreshToken(input.refreshToken)) {
      return fail(appError('SESSION_EXPIRED', 'Your session has expired. Please sign in again.'));
    }

    const digest = digestRefresh(input.refreshToken);
    const stored = await this.deps.refreshTokens.findByDigest(digest);

    if (stored === null) {
      await this.emitAudit('auth.refresh.unknown', null, input.context, {});
      return fail(appError('SESSION_EXPIRED', 'Your session has expired. Please sign in again.'));
    }

    const account = await this.deps.accounts.findById(stored.accountId);
    if (account === null) {
      return fail(appError('SESSION_EXPIRED', 'Your session has expired. Please sign in again.'));
    }

    if (stored.revokedAt !== null) {
      return fail(
        appError('SESSION_REVOKED', 'Your session has been revoked. Please sign in again.'),
      );
    }

    // Reuse detection: the presented token was already rotated away. Whoever
    // holds the old copy is not the client we last spoke to.
    if (stored.consumedAt !== null) {
      await this.deps.refreshTokens.revokeFamily(stored.familyId);
      await this.deps.sessions.revoke(stored.sessionId, 'refresh_token_reuse');
      await this.emitAudit(
        'auth.refresh.reuse_detected',
        account.id,
        input.context,
        { familyId: stored.familyId, sessionId: stored.sessionId },
        'DENIED',
      );
      return fail(
        appError('TOKEN_REUSE_DETECTED', 'Your session has been closed for security reasons.'),
      );
    }

    if (stored.expiresAt.getTime() <= this.deps.clock().getTime()) {
      return fail(appError('SESSION_EXPIRED', 'Your session has expired. Please sign in again.'));
    }

    const liveSession = await this.deps.sessions.findLive(stored.sessionId);
    if (liveSession === null) {
      return fail(
        appError('SESSION_REVOKED', 'Your session has been revoked. Please sign in again.'),
      );
    }

    if (stored.sessionEpoch !== account.sessionEpoch) {
      await this.deps.sessions.revoke(stored.sessionId, 'epoch_rotated');
      return fail(appError('SESSION_REVOKED', 'Your credentials changed. Please sign in again.'));
    }

    if (!canAuthenticate(account.state)) {
      await this.deps.sessions.revoke(stored.sessionId, 'account_unavailable');
      return fail(stateError(account.state));
    }

    const consumed = await this.deps.refreshTokens.consume(stored.id);
    if (!consumed) {
      // Lost the race to another request holding the same token. Treat exactly
      // like reuse: only one of the two requests can be legitimate.
      await this.deps.refreshTokens.revokeFamily(stored.familyId);
      await this.deps.sessions.revoke(stored.sessionId, 'refresh_token_race');
      await this.emitAudit('auth.refresh.race', account.id, input.context, {
        familyId: stored.familyId,
      });
      return fail(
        appError('TOKEN_REUSE_DETECTED', 'Your session has been closed for security reasons.'),
      );
    }

    const minted = mintRefreshToken();
    const refreshExpiresAt = new Date(
      this.deps.clock().getTime() + this.deps.env.JWT_REFRESH_TTL_SECONDS * 1_000,
    );
    await this.deps.refreshTokens.insert({
      id: this.deps.ids.next(),
      sessionId: stored.sessionId,
      accountId: account.id,
      familyId: stored.familyId,
      parentId: stored.id,
      sessionEpoch: account.sessionEpoch,
      digest: minted.digest,
      expiresAt: refreshExpiresAt,
    });

    const access = await this.deps.tokens.issue({
      accountId: account.id,
      accountType: account.accountType,
      sessionId: stored.sessionId,
      sessionEpoch: account.sessionEpoch,
    });

    await this.deps.sessions.touch(stored.sessionId);

    return ok({
      accountId: account.id,
      accountType: account.accountType,
      permissions: (await this.deps.permissionsFor(account.id)).toList(),
      session: {
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: minted.token,
        refreshTokenExpiresAt: refreshExpiresAt,
        sessionId: stored.sessionId,
      },
    });
  }

  public async logout(sessionId: string, context: RequestContext): Promise<void> {
    await this.deps.sessions.revoke(sessionId, 'user_logout');
    await this.emitAudit('auth.logout', null, context, { sessionId });
  }

  public async logoutAll(accountId: string, context: RequestContext): Promise<number> {
    const revoked = await this.deps.sessions.revokeAllForAccount(accountId, 'user_logout_all');
    await this.emitAudit('auth.logout_all', accountId, context, { revoked });
    return revoked;
  }

  /** Issues a password-reset code. Always reports success, for the same reason registration does. */
  public async requestPasswordReset(email: string, context: RequestContext): Promise<void> {
    const account = await this.deps.accounts.findByEmail(normaliseEmail(email));
    if (account !== null && account.state !== 'SOFT_DELETED' && account.state !== 'DEACTIVATED') {
      await this.issueVerificationCode(account, PASSWORD_RESET_PURPOSE, context);
    }
    await this.emitAudit('auth.password_reset.requested', account?.id ?? null, context, {});
  }

  /**
   * Completes a password reset.
   *
   * On success every session for the account is revoked: if the reset was
   * triggered by a compromise, the attacker's sessions die with it.
   */
  public async resetPassword(input: {
    readonly email: string;
    readonly code: string;
    readonly password: string;
    readonly context: RequestContext;
  }): Promise<AuthOutcome<{ readonly sessionsRevoked: number }>> {
    const account = await this.deps.accounts.findByEmail(normaliseEmail(input.email));
    if (account === null) return fail(invalidCodeError());

    const violations = evaluatePassword(input.password, {
      email: account.email,
      isAdministrative: account.accountType !== 'USER',
    });
    if (violations.length > 0) {
      return fail(
        appError('VALIDATION_FAILED', 'Password does not meet the security policy', { violations }),
      );
    }

    const stored = await this.deps.oneTimeCodes.findLatest(account.id, PASSWORD_RESET_PURPOSE);
    if (stored === null) return fail(invalidCodeError());

    const check = checkOtp(
      {
        attempts: stored.attempts,
        maxAttempts: stored.maxAttempts,
        expiresAt: stored.expiresAt,
        consumedAt: stored.consumedAt,
      },
      input.code,
      stored.codeDigest,
      account.id,
      PASSWORD_RESET_PURPOSE,
      this.deps.clock(),
    );

    if (!check.accepted) {
      await this.deps.oneTimeCodes.recordAttempt(stored.id);
      await this.emitAudit(
        'auth.password_reset.failure',
        account.id,
        input.context,
        { reason: check.reason.code },
        'DENIED',
      );
      return fail(invalidCodeError());
    }

    const consumed = await this.deps.oneTimeCodes.consume(stored.id);
    if (!consumed) return fail(invalidCodeError());

    const passwordHash = await this.deps.passwords.hash(input.password);
    await this.deps.accounts.replacePasswordHash(account.id, passwordHash);
    const sessionsRevoked = await this.deps.sessions.revokeAllForAccount(
      account.id,
      'password_reset',
    );

    await this.emitAudit('auth.password_reset.success', account.id, input.context, {
      sessionsRevoked,
    });
    return ok({ sessionsRevoked });
  }

  /** Verifies an email-verification code and activates a pending account. */
  public async verifyEmail(input: {
    readonly email: string;
    readonly code: string;
    readonly context: RequestContext;
  }): Promise<AuthOutcome<{ readonly activated: boolean }>> {
    const account = await this.deps.accounts.findByEmail(normaliseEmail(input.email));
    if (account === null) return fail(invalidCodeError());
    if (account.emailVerifiedAt !== null) return ok({ activated: true });

    const stored = await this.deps.oneTimeCodes.findLatest(account.id, 'EMAIL_VERIFY');
    if (stored === null) return fail(invalidCodeError());

    const check = checkOtp(
      {
        attempts: stored.attempts,
        maxAttempts: stored.maxAttempts,
        expiresAt: stored.expiresAt,
        consumedAt: stored.consumedAt,
      },
      input.code,
      stored.codeDigest,
      account.id,
      'EMAIL_VERIFY',
      this.deps.clock(),
    );

    if (!check.accepted) {
      await this.deps.oneTimeCodes.recordAttempt(stored.id);
      return fail(invalidCodeError());
    }

    if (!(await this.deps.oneTimeCodes.consume(stored.id))) return fail(invalidCodeError());

    await this.deps.accounts.markEmailVerified(account.id);
    await this.emitAudit('auth.email_verified', account.id, input.context, {});
    return ok({ activated: true });
  }

  private async issueVerificationCode(
    account: AccountRecord,
    purpose: OtpPurpose,
    context: RequestContext,
  ): Promise<void> {
    const code = generateOtpCode();
    const destinationHash = digestDestination(account.email);
    const expiresAt = new Date(this.deps.clock().getTime() + this.deps.env.OTP_TTL_SECONDS * 1_000);

    await this.deps.oneTimeCodes.issue({
      id: this.deps.ids.next(),
      accountId: account.id,
      purpose,
      channel: 'EMAIL',
      destinationHash,
      codeDigest: digestOtp({ accountId: account.id, purpose, code }),
      expiresAt,
      maxAttempts: this.deps.env.OTP_MAX_ATTEMPTS,
    });

    await this.deps.mailer.send({
      to: account.email,
      subject:
        purpose === 'EMAIL_VERIFY'
          ? 'Verify your SocialHub email'
          : 'Reset your SocialHub password',
      text: `Your code is ${code}. It expires in ${Math.round(this.deps.env.OTP_TTL_SECONDS / 60)} minutes.`,
    });

    await this.emitAudit('auth.otp.issued', account.id, context, {
      purpose,
      destination: maskDestination(account.email),
    });
  }

  private async openSession(
    account: AccountRecord,
    context: RequestContext,
  ): Promise<SessionTokens> {
    const sessionId = this.deps.ids.next();
    const now = this.deps.clock();
    const refreshExpiresAt = new Date(
      now.getTime() + this.deps.env.JWT_REFRESH_TTL_SECONDS * 1_000,
    );
    const sessionExpiresAt = new Date(
      Math.max(refreshExpiresAt.getTime(), now.getTime() + 86_400_000),
    );

    await this.deps.sessions.create({
      id: sessionId,
      accountId: account.id,
      expiresAt: sessionExpiresAt,
      userAgent: context.userAgent,
      ipHash: context.ipHash,
    });

    const minted: RefreshTokenMaterial = mintRefreshToken();
    await this.deps.refreshTokens.insert({
      id: this.deps.ids.next(),
      sessionId,
      accountId: account.id,
      familyId: this.deps.ids.next(),
      parentId: null,
      sessionEpoch: account.sessionEpoch,
      digest: minted.digest,
      expiresAt: refreshExpiresAt,
    });

    const access = await this.deps.tokens.issue({
      accountId: account.id,
      accountType: account.accountType,
      sessionId,
      sessionEpoch: account.sessionEpoch,
    });

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: minted.token,
      refreshTokenExpiresAt: refreshExpiresAt,
      sessionId,
    };
  }

  /**
   * `outcome` is passed explicitly rather than inferred from the action name:
   * audit classification is a security decision, and string matching on event
   * names would mislabel a new event the first time someone forgot the suffix.
   */
  private async emitAudit(
    action: string,
    accountId: string | null,
    context: RequestContext,
    payload: Readonly<Record<string, unknown>>,
    outcome: 'SUCCESS' | 'DENIED' | 'ERROR' = 'SUCCESS',
  ): Promise<void> {
    await this.deps.audit.record({
      action,
      actorId: accountId,
      actorType: null,
      resourceType: 'account',
      resourceId: accountId,
      outcome,
      ipHash: context.ipHash,
      userAgent: context.userAgent,
      traceId: context.traceId,
      payload,
    });
  }
}

/** A syntactically valid Argon2id digest used only to equalise login timing. */
const DUMMY_DIGEST =
  '$argon2id$v=19$m=47104,t=3,p=1$c29tZXNhbHRzb21lc2FsdA$J4moa2MIGp2sUayNQ1MynJmbsYw8r4Zk8y1Vc0kmPN0';

const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Keyed digest of the delivery destination. Destinations are stored hashed so
 * that a read-only database compromise cannot harvest the contact list; the
 * plaintext lives only in the accounts row, which is access-controlled.
 */
const digestDestination = (destination: string): Buffer =>
  createHash('sha256').update(`destination:v1\u0000${destination.toLowerCase()}`, 'utf8').digest();

const digestRefresh = (token: string): Buffer =>
  createHash('sha256').update(token, 'utf8').digest();

const invalidCodeError = (): AppError =>
  appError('VALIDATION_FAILED', 'That code is not valid or has expired');

const stateError = (state: AccountRecord['state']): AppError => {
  switch (state) {
    case 'SUSPENDED':
      return appError('ACCOUNT_SUSPENDED', 'This account is suspended. Contact support.');
    case 'LOCKED':
      return appError('ACCOUNT_LOCKED', 'This account is locked. Try again later.');
    case 'PENDING_VERIFICATION':
      return appError('EMAIL_NOT_VERIFIED', 'Please verify your email address to continue.');
    default:
      return appError('FORBIDDEN', 'This account cannot sign in.');
  }
};
