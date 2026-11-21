/**
 * Adapters binding persistence implementations to application ports.
 *
 * Where the port and the repository disagree in shape (for example, a repository
 * throws on a unique violation while the port reports `null`), the translation
 * happens here. Business code therefore never sees a driver-level error.
 */

import { Inject, Injectable } from '@nestjs/common';
import { DatabasePools } from '../../../database/pool.js';
import {
  PostgresAccountRepository,
  transactionalAccountStore,
  type AccountRow,
} from './account.repository.js';
import { PostgresSessionRepository } from './session.repository.js';
import type {
  AccountRecord,
  AccountStore,
  RefreshTokenStore,
  SessionStore,
} from '../application/ports.js';

const PG_UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code: unknown }).code === PG_UNIQUE_VIOLATION;

const toRecord = (row: AccountRow): AccountRecord => ({
  id: row.id,
  accountType: row.accountType,
  state: row.state,
  email: row.email,
  emailVerifiedAt: row.emailVerifiedAt,
  phone: row.phone,
  passwordHash: row.passwordHash,
  mfaEnabledAt: row.mfaEnabledAt,
  sessionEpoch: row.sessionEpoch,
  failedLoginCount: row.failedLoginCount,
  lockedUntil: row.lockedUntil,
  createdAt: row.createdAt,
});

/**
 * Account store adapter.
 *
 * Registration writes two rows — the account and its external profile — inside
 * one transaction. A half-registered account would be an orphan that can never
 * complete sign-up, so the transaction is not optional.
 */
@Injectable()
export class AccountStoreAdapter implements AccountStore {
  public constructor(
    @Inject(DatabasePools) private readonly pools: DatabasePools,
    @Inject(PostgresAccountRepository) private readonly repository: PostgresAccountRepository,
  ) {}

  public async create(input: {
    id: string;
    accountType: AccountRecord['accountType'];
    state: AccountRecord['state'];
    email: string;
    passwordHash: string;
    username: string;
    displayName: string;
  }): Promise<AccountRecord | null> {
    try {
      return await this.pools.transaction(async (client) => {
        const account = await transactionalAccountStore.insert(client, {
          id: input.id,
          accountType: input.accountType,
          state: input.state,
          email: input.email,
          passwordHash: input.passwordHash,
        });
        await client.query(
          `INSERT INTO user_profiles (account_id, username, display_name) VALUES ($1, $2, $3)`,
          [input.id, input.username, input.displayName],
        );
        return toRecord(account);
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  public async findById(id: string): Promise<AccountRecord | null> {
    const row = await this.repository.findById(id);
    return row === null ? null : toRecord(row);
  }

  public async findByEmail(email: string): Promise<AccountRecord | null> {
    const row = await this.repository.findByEmail(email);
    return row === null ? null : toRecord(row);
  }

  public emailExists(email: string): Promise<boolean> {
    return this.repository.emailExists(email);
  }

  public registerFailedLogin(
    id: string,
    threshold: number,
    lockForSeconds: number,
  ): Promise<number> {
    return this.repository.registerFailedLogin(id, threshold, lockForSeconds);
  }

  public registerSuccessfulLogin(id: string, at: Date): Promise<void> {
    return this.repository.registerSuccessfulLogin(id, at);
  }

  public async markEmailVerified(id: string): Promise<void> {
    await this.repository.markEmailVerified(id);
  }

  public replacePasswordHash(id: string, hash: string): Promise<void> {
    return this.repository.replacePasswordHash(id, hash);
  }
}

@Injectable()
export class SessionStoreAdapter implements SessionStore {
  public constructor(
    @Inject(PostgresSessionRepository) private readonly repository: PostgresSessionRepository,
  ) {}

  public create(input: {
    id: string;
    accountId: string;
    expiresAt: Date;
    userAgent: string | null;
    ipHash: string | null;
  }): Promise<void> {
    return this.repository.createSession(input);
  }

  public async findLive(
    id: string,
  ): Promise<{ id: string; accountId: string; expiresAt: Date } | null> {
    const session = await this.repository.findLiveSession(id);
    return session === null
      ? null
      : { id: session.id, accountId: session.accountId, expiresAt: session.expiresAt };
  }

  public revoke(id: string, reason: string): Promise<void> {
    return this.repository.revokeSession(id, reason);
  }

  public revokeAllForAccount(accountId: string, reason: string): Promise<number> {
    return this.repository.revokeAllForAccount(accountId, reason);
  }

  public touch(id: string): Promise<void> {
    return this.repository.touchSession(id);
  }
}

@Injectable()
export class RefreshTokenStoreAdapter implements RefreshTokenStore {
  public constructor(
    @Inject(PostgresSessionRepository) private readonly repository: PostgresSessionRepository,
  ) {}

  public insert(input: {
    id: string;
    sessionId: string;
    accountId: string;
    familyId: string;
    parentId: string | null;
    sessionEpoch: number;
    digest: Buffer;
    expiresAt: Date;
  }): Promise<void> {
    return this.repository.insertRefreshToken(input);
  }

  public async findByDigest(digest: Buffer): Promise<{
    id: string;
    sessionId: string;
    accountId: string;
    familyId: string;
    sessionEpoch: number;
    expiresAt: Date;
    consumedAt: Date | null;
    revokedAt: Date | null;
  } | null> {
    const record = await this.repository.findByDigest(digest);
    if (record === null) return null;
    return {
      id: record.id,
      sessionId: record.sessionId,
      accountId: record.accountId,
      familyId: record.familyId,
      sessionEpoch: record.sessionEpoch,
      expiresAt: record.expiresAt,
      consumedAt: record.consumedAt,
      revokedAt: record.revokedAt,
    };
  }

  public consume(id: string): Promise<boolean> {
    return this.repository.consumeRefreshToken(id);
  }

  public revokeFamily(familyId: string): Promise<number> {
    return this.repository.revokeFamily(familyId);
  }
}
