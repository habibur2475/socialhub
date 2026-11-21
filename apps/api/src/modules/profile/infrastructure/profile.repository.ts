/**
 * Profile persistence.
 *
 * Every statement is parameterised and every column is listed explicitly — no
 * `SELECT *`, because a schema change must not silently alter a response shape.
 *
 * The `visibility` column is returned here and redaction happens in the service:
 * the repository's job is to report the stored facts, not to decide who may read
 * them.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { ProfileVisibility } from '@socialhub/kernel';

import { DatabasePools } from '../../../database/pool.js';
import type { ProfileRecord, ProfileStore } from '../application/ports.js';

type RawProfileRow = {
  account_id: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_key: string | null;
  banner_key: string | null;
  visibility: ProfileVisibility;
  follower_count: number;
  following_count: number;
  created_at: Date;
};

/**
 * Columns are qualified because both reads join `accounts`, which also has
 * `created_at`. An unqualified list would make every profile read fail with an
 * ambiguous column rather than returning the wrong one — the failure is loud, but
 * it is still a failure.
 */
const COLUMNS = `p.account_id, p.username, p.display_name, p.bio, p.avatar_key,
                 p.banner_key, p.visibility, p.follower_count, p.following_count, p.created_at`;

/** The same list for statements where `user_profiles` is aliased to `p`. */
const ALIASED_COLUMNS = COLUMNS.replaceAll('\n', ' ').replaceAll('\s+', ' ').trim();

const toRecord = (row: RawProfileRow): ProfileRecord => ({
  accountId: row.account_id,
  username: row.username,
  displayName: row.display_name,
  bio: row.bio,
  avatarKey: row.avatar_key,
  bannerKey: row.banner_key,
  visibility: row.visibility,
  followerCount: row.follower_count,
  followingCount: row.following_count,
  createdAt: row.created_at,
});

@Injectable()
export class PostgresProfileRepository implements ProfileStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  public async findById(accountId: string): Promise<ProfileRecord | null> {
    // The join excludes soft-deleted accounts, so a deleted account is
    // indistinguishable from a missing one at every call site.
    const result = await this.pools.pool().query<RawProfileRow>(
      `SELECT ${ALIASED_COLUMNS}
         FROM user_profiles p
         JOIN accounts a ON a.id = p.account_id
        WHERE p.account_id = $1 AND a.deleted_at IS NULL`,
      [accountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  public async findByUsername(username: string): Promise<ProfileRecord | null> {
    const result = await this.pools.pool().query<RawProfileRow>(
      `SELECT ${ALIASED_COLUMNS}
         FROM user_profiles p
         JOIN accounts a ON a.id = p.account_id
        WHERE p.username = $1 AND a.deleted_at IS NULL`,
      [username],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  public async update(
    accountId: string,
    changes: {
      readonly displayName?: string;
      readonly bio?: string | null;
      readonly visibility?: ProfileVisibility;
    },
  ): Promise<ProfileRecord | null> {
    // COALESCE needs a sentinel to distinguish "leave alone" from "set to null",
    // and a nullable column has no spare sentinel. Building the SET list from the
    // keys actually present keeps the statement honest and stays parameterised.
    const assignments: string[] = [];
    const values: unknown[] = [accountId];

    if (changes.displayName !== undefined) {
      values.push(changes.displayName);
      assignments.push(`display_name = $${values.length}`);
    }
    if (changes.bio !== undefined) {
      values.push(changes.bio);
      assignments.push(`bio = $${values.length}`);
    }
    if (changes.visibility !== undefined) {
      values.push(changes.visibility);
      assignments.push(`visibility = $${values.length}`);
    }

    if (assignments.length === 0) return this.findById(accountId);

    const result = await this.pools.pool().query<RawProfileRow>(
      `UPDATE user_profiles p SET ${assignments.join(', ')}
        WHERE p.account_id = $1
        RETURNING ${ALIASED_COLUMNS}`,
      values,
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  public async usernameTaken(username: string, exceptAccountId: string): Promise<boolean> {
    const result = await this.pools
      .pool()
      .query('SELECT 1 FROM user_profiles WHERE username = $1 AND account_id <> $2 LIMIT 1', [
        username,
        exceptAccountId,
      ]);
    return result.rowCount !== null && result.rowCount > 0;
  }

  public async changeUsername(accountId: string, username: string): Promise<ProfileRecord | null> {
    // The unique index remains the final arbiter: the pre-check above closes the
    // common race, and a lost race surfaces as a constraint error the filter
    // turns into CONFLICT rather than a 500.
    const result = await this.pools.pool().query<RawProfileRow>(
      `UPDATE user_profiles p SET username = $2 WHERE p.account_id = $1
       RETURNING ${ALIASED_COLUMNS}`,
      [accountId, username],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }
}
