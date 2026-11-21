/**
 * Access token minting and verification.
 *
 * HS256 with a 512-bit secret is used for phase 1 because issuance and
 * verification happen in one trust domain (the API). The interface is asymmetric-
 * ready: swapping in RS256/EdDSA means changing this class alone, which is the
 * point of keeping token shape in the domain layer.
 *
 * Verification is strict about every claim. `algorithms` is pinned to defeat the
 * "alg: none" and algorithm-confusion classes of attack, issuer and audience are
 * both checked, and the session epoch is compared by the caller.
 */

import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AccountType } from '@socialhub/kernel';

import { ENV } from '../../../config/config.module.js';
import { CLOCK } from '../auth.tokens.js';
import type { Env } from '../../../config/env.js';
import type { AccessTokenIssuer } from '../application/ports.js';
import type { AccessTokenClaims } from '../domain/token.js';

const ALGORITHM = 'HS256';

@Injectable()
export class JwtAccessTokenIssuer implements AccessTokenIssuer {
  public constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(ENV)
    private readonly env: Pick<
      Env,
      'JWT_ACCESS_SECRET' | 'JWT_ACCESS_TTL_SECONDS' | 'JWT_ISSUER' | 'JWT_AUDIENCE'
    >,
    @Inject(CLOCK) private readonly now: () => Date,
  ) {}

  public async issue(input: {
    accountId: string;
    accountType: AccountType;
    sessionId: string;
    sessionEpoch: number;
  }): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(this.now().getTime() / 1_000);
    const expiresAt = new Date((issuedAt + this.env.JWT_ACCESS_TTL_SECONDS) * 1_000);

    const claims: Omit<AccessTokenClaims, 'iss' | 'aud' | 'iat' | 'exp' | 'jti'> = {
      sub: input.accountId,
      typ: 'access',
      acc: input.accountType,
      sid: input.sessionId,
      epc: input.sessionEpoch,
    };

    const token = await this.jwt.signAsync(claims, {
      algorithm: ALGORITHM,
      secret: this.env.JWT_ACCESS_SECRET,
      issuer: this.env.JWT_ISSUER,
      audience: this.env.JWT_AUDIENCE,
      expiresIn: this.env.JWT_ACCESS_TTL_SECONDS,
      // A unique id per token supports targeted revocation of a single access
      // token in the denylist without invalidating the rest of the session.
      jwtid: randomUUID(),
    });

    return { token, expiresAt };
  }

  public async verify(token: string): Promise<{
    accountId: string;
    accountType: AccountType;
    sessionId: string;
    sessionEpoch: number;
    expiresAt: Date;
  } | null> {
    try {
      const payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        algorithms: [ALGORITHM],
        secret: this.env.JWT_ACCESS_SECRET,
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
        clockTolerance: 5,
      });

      const sub = payload['sub'];
      const typ = payload['typ'];
      const acc = payload['acc'];
      const sid = payload['sid'];
      const epc = payload['epc'];
      const exp = payload['exp'];

      if (
        typeof sub !== 'string' ||
        typ !== 'access' ||
        (acc !== 'USER' && acc !== 'STAFF' && acc !== 'ROOT') ||
        typeof sid !== 'string' ||
        typeof epc !== 'number' ||
        typeof exp !== 'number'
      ) {
        return null;
      }

      return {
        accountId: sub,
        accountType: acc,
        sessionId: sid,
        sessionEpoch: epc,
        expiresAt: new Date(exp * 1_000),
      };
    } catch {
      // Any verification failure is a null result: callers must not be able to
      // distinguish an expired token from a forged one.
      return null;
    }
  }
}
