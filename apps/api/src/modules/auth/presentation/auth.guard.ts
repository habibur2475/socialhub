/**
 * Bearer authentication guard.
 *
 * A JWT alone is not a session. Signature validity proves the token was minted
 * by us; it does not prove the session is still alive, that the credentials have
 * not rotated, or that the account has not been suspended since. This guard
 * therefore performs the cheap local check first (signature, claims, expiry),
 * then one cache-backed session lookup. The Redis hit is the price of revocation
 * being immediate instead of "within the token TTL".
 */

import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { appError, type AccountType, canAuthenticate, type AccountState } from '@socialhub/kernel';

import { DomainException } from '../../../common/filters/domain-exception.js';
import type { AccessTokenIssuer, AccountStore, SessionStore } from '../application/ports.js';
import { ACCESS_TOKEN_ISSUER, ACCOUNT_STORE, SESSION_STORE } from '../auth.tokens.js';

export type AuthenticatedPrincipal = {
  readonly accountId: string;
  readonly accountType: AccountType;
  readonly state: AccountState;
  readonly sessionId: string;
};

export const PRINCIPAL_KEY = 'principal' as const;

export type RequestWithPrincipal = Request & {
  principal?: AuthenticatedPrincipal;
};

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

@Injectable()
export class AuthGuard implements CanActivate {
  public constructor(
    @Inject(ACCESS_TOKEN_ISSUER) private readonly tokens: AccessTokenIssuer,
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
    @Inject(ACCOUNT_STORE) private readonly accounts: AccountStore,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const header = request.header('authorization');
    const match = header === undefined ? null : BEARER_PATTERN.exec(header);

    if (match === null || match[1] === undefined) {
      throw new DomainException(appError('UNAUTHENTICATED', 'Authentication is required'));
    }

    const claims = await this.tokens.verify(match[1]);
    if (claims === null) {
      throw new DomainException(appError('UNAUTHENTICATED', 'Your session is no longer valid'));
    }

    const session = await this.sessions.findLive(claims.sessionId);
    if (session === null || session.accountId !== claims.accountId) {
      throw new DomainException(appError('SESSION_REVOKED', 'Your session has been revoked'));
    }

    const account = await this.accounts.findById(claims.accountId);
    if (account === null) {
      throw new DomainException(appError('UNAUTHENTICATED', 'Your session is no longer valid'));
    }

    // Two independent revocations, both cheap: the epoch catches credential
    // changes, the state gate catches administrative action.
    if (account.sessionEpoch !== claims.sessionEpoch) {
      throw new DomainException(appError('SESSION_REVOKED', 'Your credentials changed'));
    }
    if (!canAuthenticate(account.state)) {
      throw new DomainException(appError('ACCOUNT_SUSPENDED', 'This account cannot use the API'));
    }

    request.principal = {
      accountId: account.id,
      accountType: account.accountType,
      state: account.state,
      sessionId: claims.sessionId,
    };
    return true;
  }
}
