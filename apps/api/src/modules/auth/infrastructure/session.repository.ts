/**
 * Session and refresh-token persistence.
 *
 * The refresh-token table is the source of truth for a live session. Writes go
 * through small, single-purpose statements so that the rotation logic in the
 * service layer stays readable and testable.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools, type Queryable } from '../../../database/pool.js';

export type SessionRecord = {
  readonly id: string;
  readonly accountId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
};

export type RefreshTokenRecord = {
  readonly id: string;
  readonly sessionId: string;
  readonly accountId: string;
  readonly familyId: string;
  readonly sessionEpoch: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
};

type RawRefreshRow = {
  id: string;
  session_id: string;
  account_id: string;
  family_id: string;
  session_epoch: number;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
};

const toRefresh = (row: RawRefreshRow): RefreshTokenRecord => ({
  id: row.id,
  sessionId: row.session_id,
  accountId: row.account_id,
  familyId: row.family_id,
  sessionEpoch: row.session_epoch,
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at,
  revokedAt: row.revoked_at,
});

export type NewSession = {
  readonly id: string;
  readonly accountId: string;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  readonly ipHash: string | null;
};

export type NewRefreshToken = {
  readonly id: string;
  readonly sessionId: string;
  readonly accountId: string;
  readonly familyId: string;
  readonly parentId: string | null;
  readonly sessionEpoch: number;
  readonly digest: Buffer;
  readonly expiresAt: Date;
};

export type SessionRepository = {
  createSession(session: NewSession): Promise<void>;
  findLiveSession(id: string): Promise<SessionRecord | null>;
  revokeSession(id: string, reason: string): Promise<void>;
  revokeAllForAccount(accountId: string, reason: string): Promise<number>;
  insertRefreshToken(token: NewRefreshToken): Promise<void>;
  findByDigest(digest: Buffer): Promise<RefreshTokenRecord | null>;
  /** Marks a token consumed; returns false when another process already did. */
  consumeRefreshToken(id: string): Promise<boolean>;
  revokeFamily(familyId: string): Promise<number>;
  touchSession(id: string): Promise<void>;
};

@Injectable()
export class PostgresSessionRepository implements SessionRepository {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  private db(): Queryable {
    return this.pools.pool();
  }

  public async createSession(session: NewSession): Promise<void> {
    await this.db().query(
      `INSERT INTO sessions (id, account_id, expires_at, user_agent, ip_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [session.id, session.accountId, session.expiresAt, session.userAgent, session.ipHash],
    );
  }

  public async findLiveSession(id: string): Promise<SessionRecord | null> {
    const { rows } = await this.db().query<{
      id: string;
      account_id: string;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, account_id, expires_at, revoked_at
         FROM sessions
        WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  public async revokeSession(id: string, reason: string): Promise<void> {
    await this.db().query(
      `UPDATE sessions
          SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = COALESCE(revoked_reason, $2)
        WHERE id = $1`,
      [id, reason],
    );
    await this.db().query(
      `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE session_id = $1`,
      [id],
    );
  }

  public async revokeAllForAccount(accountId: string, reason: string): Promise<number> {
    const { rowCount } = await this.db().query(
      `UPDATE sessions
          SET revoked_at = now(), revoked_reason = $2
        WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId, reason],
    );
    await this.db().query(
      `UPDATE refresh_tokens
          SET revoked_at = now()
        WHERE account_id = $1 AND revoked_at IS NULL`,
      [accountId],
    );
    return rowCount ?? 0;
  }

  public async insertRefreshToken(token: NewRefreshToken): Promise<void> {
    await this.db().query(
      `INSERT INTO refresh_tokens
         (id, session_id, account_id, family_id, parent_id, session_epoch, token_digest, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        token.id,
        token.sessionId,
        token.accountId,
        token.familyId,
        token.parentId,
        token.sessionEpoch,
        token.digest,
        token.expiresAt,
      ],
    );
  }

  public async findByDigest(digest: Buffer): Promise<RefreshTokenRecord | null> {
    const { rows } = await this.db().query<RawRefreshRow>(
      `SELECT id, session_id, account_id, family_id, session_epoch,
              issued_at, expires_at, consumed_at, revoked_at
         FROM refresh_tokens
        WHERE token_digest = $1`,
      [digest],
    );
    const row = rows[0];
    return row === undefined ? null : toRefresh(row);
  }

  /**
   * Conditional update: only the request that flips the row from unconsumed to
   * consumed wins. A concurrent replay therefore sees zero rows and is rejected,
   * which is what makes reuse detection reliable under race conditions.
   */
  public async consumeRefreshToken(id: string): Promise<boolean> {
    const { rowCount } = await this.db().query(
      `UPDATE refresh_tokens SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  public async revokeFamily(familyId: string): Promise<number> {
    const { rowCount } = await this.db().query(
      `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now())
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId],
    );
    return rowCount ?? 0;
  }

  public async touchSession(id: string): Promise<void> {
    await this.db().query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [id]);
  }
}
