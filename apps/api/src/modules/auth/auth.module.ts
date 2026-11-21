/**
 * Auth module composition.
 *
 * The wiring is explicit on purpose. Each token below states which
 * implementation satisfies which port, so the dependency graph can be read
 * without opening a single class: swapping Redis for another cache, or Postgres
 * for a sharded client, is a change in this file only.
 */

import { Module } from '@nestjs/common';

import { JwtModule } from '@nestjs/jwt';

import { ConfigModule, ENV } from '../../config/config.module.js';
import { AuditModule } from '../../common/audit/audit.module.js';
import { CACHE } from '../../database/cache.provider.js';
import { DatabaseModule } from '../../database/database.module.js';
import { CacheModule } from '../../database/cache.module.js';
import type { CachePort } from '../../common/cache/cache-port.js';
import { JsonLogger } from '../../common/logging/logger.js';
import { uuidv7Identifiers } from '../../common/ids/system-clock.js';
import { Argon2PasswordHasher } from '../../common/crypto/password.js';
import type { Env } from '../../config/env.js';
import type { PermissionMask } from '@socialhub/kernel';

import {
  ACCESS_TOKEN_ISSUER,
  ACCOUNT_STORE,
  AUDIT_SINK,
  AUTH_SERVICE,
  CLOCK,
  IDS,
  LOGIN_THROTTLE,
  MAILER,
  ONE_TIME_CODE_STORE,
  PASSWORD_SERVICE,
  PERMISSIONS_FOR,
  REFRESH_TOKEN_STORE,
  SESSION_STORE,
} from './auth.tokens.js';
import { AuthService } from './application/auth.service.js';
import type {
  AccountStore,
  AccessTokenIssuer,
  AuditSink,
  Clock,
  IdGenerator,
  LoginThrottle,
  Mailer,
  OneTimeCodeStore,
  PasswordService,
  RefreshTokenStore,
  SessionStore,
} from './application/ports.js';
import { AuthGuard } from './presentation/auth.guard.js';
import { AuthController } from './presentation/auth.controller.js';
import {
  AccountStoreAdapter,
  RefreshTokenStoreAdapter,
  SessionStoreAdapter,
} from './infrastructure/adapters.js';
import { PostgresAccountRepository } from './infrastructure/account.repository.js';
import { PostgresSessionRepository } from './infrastructure/session.repository.js';
import { PostgresOneTimeCodeRepository } from './infrastructure/postgres-one-time-code.repository.js';
import { JwtAccessTokenIssuer } from './infrastructure/jwt-token-issuer.js';
import { LogMailer } from './infrastructure/log-mailer.js';
import { LoginThrottleService } from './infrastructure/redis-login-throttle.js';
import { PermissionCache } from './infrastructure/permission-cache.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CacheModule,
    AuditModule,
    JwtModule.register({
      // Secrets are passed per call in JwtAccessTokenIssuer so that access and
      // refresh keys never share a registration.
      global: false,
    }),
  ],
  controllers: [AuthController],
  providers: [
    // Infrastructure providers are global (DatabaseModule, CacheModule); declaring
    // them here would create a second pool and a second Redis socket.
    PostgresAccountRepository,
    PostgresSessionRepository,
    PostgresOneTimeCodeRepository,
    PermissionCache,

    // `IdGenerator` is an object; binding its exact member (rather than the module
    // object) keeps the provider honest with the port type, so a wrong shape
    // cannot slip through `useValue`. `CLOCK` comes from the imported modules.
    { provide: IDS, useValue: uuidv7Identifiers },
    {
      provide: PASSWORD_SERVICE,
      useFactory: (env: Env): PasswordService => new Argon2PasswordHasher(env),
      inject: [ENV],
    },
    { provide: ACCOUNT_STORE, useClass: AccountStoreAdapter },
    { provide: SESSION_STORE, useClass: SessionStoreAdapter },
    { provide: REFRESH_TOKEN_STORE, useClass: RefreshTokenStoreAdapter },
    { provide: ONE_TIME_CODE_STORE, useExisting: PostgresOneTimeCodeRepository },
    { provide: ACCESS_TOKEN_ISSUER, useClass: JwtAccessTokenIssuer },
    {
      provide: LOGIN_THROTTLE,
      useFactory: (cache: CachePort, logger: JsonLogger, env: Env): LoginThrottle =>
        new LoginThrottleService(cache, logger, {
          identityLimit: Math.max(env.MAX_FAILED_LOGINS * 2, 10),
          identityWindowMs: env.LOCKOUT_SECONDS * 1_000,
          sourceLimit: Math.max(env.MAX_FAILED_LOGINS * 10, 50),
          sourceWindowMs: env.LOCKOUT_SECONDS * 1_000,
          prefix: 'throttle:login',
        }),
      inject: [CACHE, JsonLogger, ENV],
    },
    {
      // Selected by MAIL_TRANSPORT rather than hardcoded: env parsing rejects the
      // log transport in production, so this cannot deploy a code-leaking mailer.
      provide: MAILER,
      useFactory: (logger: JsonLogger, env: Env): Mailer => {
        switch (env.MAIL_TRANSPORT) {
          case 'log':
            return new LogMailer(logger);
          case 'smtp':
            throw new Error('MAIL_TRANSPORT=smtp requires the SMTP adapter (not yet implemented)');
        }
      },
      inject: [JsonLogger, ENV],
    },
    {
      provide: PERMISSIONS_FOR,
      useFactory: (cache: PermissionCache) => (accountId: string) =>
        cache.resolve(accountId).then((r) => r.mask),
      inject: [PermissionCache],
    },
    {
      provide: AUTH_SERVICE,
      // Nest injects the resolved dependencies positionally; the service takes a
      // single named-object argument, so the factory reassembles it explicitly.
      // Doing this by hand (rather than with a decorator) keeps every dependency
      // visible in one place and order-checked by the type system.
      useFactory: (
        env: Env,
        accounts: AccountStore,
        sessions: SessionStore,
        refreshTokens: RefreshTokenStore,
        oneTimeCodes: OneTimeCodeStore,
        passwords: PasswordService,
        tokens: AccessTokenIssuer,
        throttle: LoginThrottle,
        mailer: Mailer,
        audit: AuditSink,
        clock: Clock,
        ids: IdGenerator,
        permissionsFor: (accountId: string) => Promise<PermissionMask>,
      ): AuthService =>
        new AuthService({
          env,
          accounts,
          sessions,
          refreshTokens,
          oneTimeCodes,
          passwords,
          tokens,
          throttle,
          mailer,
          audit,
          clock,
          ids,
          permissionsFor,
        }),
      inject: [
        ENV,
        ACCOUNT_STORE,
        SESSION_STORE,
        REFRESH_TOKEN_STORE,
        ONE_TIME_CODE_STORE,
        PASSWORD_SERVICE,
        ACCESS_TOKEN_ISSUER,
        LOGIN_THROTTLE,
        MAILER,
        AUDIT_SINK,
        CLOCK,
        IDS,
        PERMISSIONS_FOR,
      ],
    },
    AuthGuard,
  ],
  exports: [
    AUTH_SERVICE,
    AuthGuard,
    PermissionCache,
    ACCESS_TOKEN_ISSUER,
    ACCOUNT_STORE,
    SESSION_STORE,
    IDS,
  ],
})
export class AuthModule {}

export {
  ACCESS_TOKEN_ISSUER,
  ACCOUNT_STORE,
  AUDIT_SINK,
  AUTH_SERVICE,
  CLOCK,
  IDS,
  LOGIN_THROTTLE,
  MAILER,
  ONE_TIME_CODE_STORE,
  PASSWORD_SERVICE,
  PERMISSIONS_FOR,
  REFRESH_TOKEN_STORE,
  SESSION_STORE,
};
