/**
 * One-time code persistence.
 *
 * `findLatest` reads the newest unconsumed row for a purpose: older codes are
 * implicitly superseded, so requesting a second code invalidates the first
 * without a write.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools, type Queryable } from '../../../database/pool.js';
import type { OneTimeCodeStore } from '../application/ports.js';

@Injectable()
export class PostgresOneTimeCodeRepository implements OneTimeCodeStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  private db(): Queryable {
    return this.pools.pool();
  }

  public async issue(input: {
    id: string;
    accountId: string;
    purpose: string;
    channel: 'EMAIL' | 'SMS';
    destinationHash: Buffer;
    codeDigest: Buffer;
    expiresAt: Date;
    maxAttempts: number;
  }): Promise<void> {
    await this.db().query(
      `INSERT INTO verification_codes
         (id, account_id, purpose, channel, destination_hash, code_digest, expires_at, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.id,
        input.accountId,
        input.purpose,
        input.channel,
        input.destinationHash,
        input.codeDigest,
        input.expiresAt,
        input.maxAttempts,
      ],
    );
  }

  public async findLatest(
    accountId: string,
    purpose: string,
  ): Promise<{
    id: string;
    codeDigest: Buffer;
    attempts: number;
    maxAttempts: number;
    expiresAt: Date;
    consumedAt: Date | null;
  } | null> {
    const { rows } = await this.db().query<{
      id: string;
      code_digest: Buffer;
      attempts: number;
      max_attempts: number;
      expires_at: Date;
      consumed_at: Date | null;
    }>(
      `SELECT id, code_digest, attempts, max_attempts, expires_at, consumed_at
         FROM verification_codes
        WHERE account_id = $1 AND purpose = $2 AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [accountId, purpose],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      codeDigest: row.code_digest,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    };
  }

  public async recordAttempt(id: string): Promise<void> {
    // Bounded by the CHECK on the row; incrementing past max_attempts is a no-op
    // so a race cannot push the counter out of range.
    await this.db().query(`UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1`, [
      id,
    ]);
  }

  public async consume(id: string): Promise<boolean> {
    const { rowCount } = await this.db().query(
      `UPDATE verification_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }
}
