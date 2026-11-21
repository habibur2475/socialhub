/**
 * Social graph persistence.
 *
 * Two invariants are enforced by the schema, not here, and this class relies on
 * them deliberately: the composite primary key on each table makes every write
 * idempotent (`ON CONFLICT DO NOTHING`), and triggers sever follows on block and
 * maintain the counters. Reimplementing either in TypeScript would create a
 * second source of truth.
 *
 * The relation query is a single round trip. Three separate lookups would be
 * three chances to forget one, and the visibility decision needs all three.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools } from '../../../database/pool.js';
import type {
  ProfilePage,
  ProfileSummary,
  RelationFacts,
  SocialGraphStore,
} from '../application/ports.js';

type RelationRow = {
  viewer_follows_target: boolean;
  follow_pending: boolean;
  blocked: boolean;
};

type SummaryRow = {
  account_id: string;
  username: string;
  display_name: string;
  avatar_key: string | null;
  bio: string | null;
};

/** Columns shared by the follower and following lists. */
const SUMMARY_COLUMNS = 'p.account_id, p.username, p.display_name, p.avatar_key, p.bio';

/**
 * Both lists are the same query with one column swapped: a follower list reads
 * `follower_id` where a following list reads `followee_id`. Parameterising the
 * column keeps one statement, one keyset predicate and one redaction rule — two
 * hand-written queries would drift.
 */
const SUMMARY_SELECT = (direction: 'followers' | 'following'): string => {
  // Both columns are chosen together from a closed pair, so neither can ever be
  // interpolated from user input.
  const other = direction === 'followers' ? 'follower_id' : 'followee_id';
  const owner = direction === 'followers' ? 'followee_id' : 'follower_id';

  return `
  SELECT ${SUMMARY_COLUMNS}
    FROM follows f
    JOIN user_profiles p ON p.account_id = f.${other}
    JOIN accounts a ON a.id = p.account_id
   WHERE f.${owner} = $1
     AND f.accepted_at IS NOT NULL
     AND a.deleted_at IS NULL
     AND ($2::uuid IS NULL OR f.${other} > $2::uuid)
   ORDER BY f.${other}
   LIMIT $3`;
};

@Injectable()
export class PostgresSocialGraphRepository implements SocialGraphStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  public async relationBetween(viewerId: string, targetId: string): Promise<RelationFacts> {
    const result = await this.pools.pool().query<RelationRow>(
      `SELECT
         EXISTS (
           SELECT 1 FROM follows
            WHERE follower_id = $1 AND followee_id = $2 AND accepted_at IS NOT NULL
         ) AS viewer_follows_target,
         EXISTS (
           SELECT 1 FROM follows
            WHERE follower_id = $1 AND followee_id = $2 AND accepted_at IS NULL
         ) AS follow_pending,
         EXISTS (
           SELECT 1 FROM blocks
            WHERE (blocker_id = $1 AND blocked_id = $2)
               OR (blocker_id = $2 AND blocked_id = $1)
         ) AS blocked`,
      [viewerId, targetId],
    );

    const row = result.rows[0];
    return {
      viewerFollowsTarget: row?.viewer_follows_target ?? false,
      followPending: row?.follow_pending ?? false,
      blocked: row?.blocked ?? false,
    };
  }

  public async follow(followerId: string, followeeId: string, accepted: boolean): Promise<void> {
    await this.pools.pool().query(
      `INSERT INTO follows (follower_id, followee_id, accepted_at)
       VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END)
       ON CONFLICT (follower_id, followee_id) DO UPDATE
         SET accepted_at = COALESCE(follows.accepted_at, EXCLUDED.accepted_at)`,
      [followerId, followeeId, accepted],
    );
  }

  public async unfollow(followerId: string, followeeId: string): Promise<boolean> {
    const result = await this.pools
      .pool()
      .query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [
        followerId,
        followeeId,
      ]);
    return (result.rowCount ?? 0) > 0;
  }

  public async cancelFollowRequest(followerId: string, followeeId: string): Promise<boolean> {
    const result = await this.pools
      .pool()
      .query(
        'DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2 AND accepted_at IS NULL',
        [followerId, followeeId],
      );
    return (result.rowCount ?? 0) > 0;
  }

  public async acceptFollowRequest(followerId: string, followeeId: string): Promise<boolean> {
    // The `accepted_at IS NULL` predicate makes acceptance a one-shot transition:
    // a second call finds no row and reports "no request", rather than
    // re-counting an existing edge.
    const result = await this.pools.pool().query(
      `UPDATE follows SET accepted_at = now()
        WHERE follower_id = $1 AND followee_id = $2 AND accepted_at IS NULL`,
      [followerId, followeeId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async block(blockerId: string, blockedId: string, reason: string | null): Promise<void> {
    // Existing follows are severed by a trigger, so this statement alone leaves
    // no edge behind.
    await this.pools.pool().query(
      `INSERT INTO blocks (blocker_id, blocked_id, reason) VALUES ($1, $2, $3)
       ON CONFLICT (blocker_id, blocked_id) DO UPDATE
         SET reason = COALESCE(EXCLUDED.reason, blocks.reason)`,
      [blockerId, blockedId, reason],
    );
  }

  public async unblock(blockerId: string, blockedId: string): Promise<boolean> {
    const result = await this.pools
      .pool()
      .query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [
        blockerId,
        blockedId,
      ]);
    return (result.rowCount ?? 0) > 0;
  }

  public async isBlockedEitherWay(a: string, b: string): Promise<boolean> {
    const result = await this.pools.pool().query(
      `SELECT 1 FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
        LIMIT 1`,
      [a, b],
    );
    return (result.rowCount ?? 0) > 0;
  }

  public async countFollowing(accountId: string): Promise<number> {
    const result = await this.pools.pool().query<{
      n: string;
    }>('SELECT count(*)::text AS n FROM follows WHERE follower_id = $1', [accountId]);
    return Number(result.rows[0]?.n ?? '0');
  }

  public async listFollowing(
    accountId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<ProfilePage> {
    return this.readPage('following', accountId, page);
  }

  public async listFollowers(
    accountId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<ProfilePage> {
    return this.readPage('followers', accountId, page);
  }

  /**
   * Reads one extra row to learn whether a further page exists, then discards it.
   * The alternative — counting the full list — is O(n) per page; the alternative
   * of inferring from page size is wrong on exact multiples.
   */
  private async readPage(
    direction: 'followers' | 'following',
    accountId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<ProfilePage> {
    const result = await this.pools
      .pool()
      .query<SummaryRow>(SUMMARY_SELECT(direction), [accountId, page.cursor, page.limit + 1]);

    const rows = result.rows.slice(0, page.limit);
    return { items: toSummaries(rows), hasMore: result.rows.length > page.limit };
  }
}

const toSummaries = (rows: readonly SummaryRow[]): readonly ProfileSummary[] =>
  rows.map((row) => ({
    accountId: row.account_id,
    username: row.username,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
    bio: row.bio,
  }));
