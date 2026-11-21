/**
 * Post persistence.
 *
 * Every read path here applies `can_view_post()`. That is not belt-and-braces:
 * the alternative is to return rows and filter them in TypeScript, which loads
 * content the viewer may not see into process memory, breaks pagination (a page
 * of 20 filtered rows may contain 3) and creates a second implementation of the
 * visibility rule that can disagree with the first.
 *
 * Post ids are uuidv7, so `id DESC` is publication order and the primary key is
 * the timeline index — no `ORDER BY created_at, id` tie-breaker is needed, and
 * the keyset predicate is a single-column comparison.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools } from '../../../database/pool.js';
import type {
  PostAuthor,
  PostRecord,
  PostStore,
  TimelinePage,
  TimelineQuery,
} from '../application/ports.js';
import type { PostAudience } from '@socialhub/kernel';

type RawPostRow = {
  id: string;
  account_id: string;
  body: string;
  visibility: PostAudience;
  like_count: number;
  reply_count: number;
  repost_count: number;
  reply_to: string | null;
  repost_of: string | null;
  edited_at: Date | null;
  created_at: Date;
  username: string;
  display_name: string;
  avatar_key: string | null;
  liked_by_me: boolean;
};

/**
 * `liked_by_me` is computed per row with an EXISTS against the caller's own
 * likes. A correlated subquery sounds expensive, but it is an index probe on
 * `post_likes (post_id, account_id)` — the primary key — so it costs one lookup
 * per row and removes an entire second round trip (and the reconcile logic that
 * would follow it).
 */
const SELECT_POSTS = `
  SELECT p.id, p.account_id, p.body, p.visibility,
         p.like_count, p.reply_count, p.repost_count,
         p.reply_to, p.repost_of, p.edited_at, p.created_at,
         pr.username, pr.display_name, pr.avatar_key,
         EXISTS (
           SELECT 1 FROM post_likes l
            WHERE l.post_id = p.id AND l.account_id = $1
         ) AS liked_by_me
    FROM posts p
    JOIN accounts a ON a.id = p.account_id
    JOIN user_profiles pr ON pr.account_id = p.account_id
`;

const toAuthor = (row: RawPostRow): PostAuthor => ({
  accountId: row.account_id,
  username: row.username,
  displayName: row.display_name,
  avatarKey: row.avatar_key,
});

const toPost = (row: RawPostRow): PostRecord => ({
  id: row.id,
  authorId: row.account_id,
  body: row.body,
  visibility: row.visibility,
  likeCount: row.like_count,
  replyCount: row.reply_count,
  repostCount: row.repost_count,
  replyTo: row.reply_to,
  repostOf: row.repost_of,
  editedAt: row.edited_at,
  createdAt: row.created_at,
  author: toAuthor(row),
  likedByMe: row.liked_by_me,
});

/** Reads one row beyond the page so `hasMore` is a fact, not a guess. */
const toPage = (rows: readonly RawPostRow[], limit: number): TimelinePage => ({
  items: rows.slice(0, limit).map(toPost),
  hasMore: rows.length > limit,
});

@Injectable()
export class PostgresPostRepository implements PostStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  public async find(id: string, viewerId: string): Promise<PostRecord | null> {
    const result = await this.pools
      .pool()
      .query<RawPostRow>(`${SELECT_POSTS} WHERE p.id = $2`, [viewerId, id]);
    const row = result.rows[0];
    return row === undefined ? null : toPost(row);
  }

  public async create(input: {
    readonly id: string;
    readonly authorId: string;
    readonly body: string;
    readonly visibility: PostAudience;
    readonly replyTo: string | null;
    readonly audienceAccountIds: readonly string[];
  }): Promise<PostRecord | null> {
    // The post and its audience snapshot are one transaction: a post that became
    // visible before its audience rows existed would be invisible to the very
    // people it was addressed to, and visible to nobody else.
    return this.pools.transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO posts (id, account_id, body, visibility, reply_to)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [input.id, input.authorId, input.body, input.visibility, input.replyTo],
      );
      const postId = inserted.rows[0]?.id;
      if (postId === undefined) return null;

      if (input.audienceAccountIds.length > 0) {
        // A single statement rather than one insert per follower: the fan-out can
        // be thousands of rows, and round-tripping each one would dominate the
        // request.
        await client.query(
          `INSERT INTO post_audience (post_id, account_id)
           SELECT $1, unnest($2::uuid[])
           ON CONFLICT DO NOTHING`,
          [postId, input.audienceAccountIds],
        );
      }

      const result = await client.query<RawPostRow>(`${SELECT_POSTS} WHERE p.id = $2`, [
        input.authorId,
        postId,
      ]);
      const row = result.rows[0];
      return row === undefined ? null : toPost(row);
    });
  }

  public async updateBody(id: string, authorId: string, body: string): Promise<PostRecord | null> {
    // The author predicate is in the WHERE clause, so a non-owner's update affects
    // no rows and is reported as missing rather than forbidden.
    const updated = await this.pools.pool().query<{ id: string }>(
      `UPDATE posts SET body = $3, edited_at = now()
        WHERE id = $1 AND account_id = $2
        RETURNING id`,
      [id, authorId, body],
    );
    if (updated.rowCount === 0) return null;
    return this.find(id, authorId);
  }

  public async remove(id: string, authorId: string): Promise<boolean> {
    const removed = await this.pools
      .pool()
      .query('DELETE FROM posts WHERE id = $1 AND account_id = $2', [id, authorId]);
    return (removed.rowCount ?? 0) > 0;
  }

  /**
   * Home timeline.
   *
   * Three sources, unioned and paginated as one:
   *   1. the viewer's own posts, whatever their visibility;
   *   2. posts addressed to the viewer through the materialised audience;
   *   3. public posts, so a new account with no follows still sees something.
   *
   * `can_view_post()` is still applied to every row. The union is an *index
   * plan*, not a permission decision: a post could have been addressed to the
   * viewer and then blocked, and the third branch is the widest one. Removing the
   * check because "the audience table already filtered" is exactly the mistake
   * that leaks a blocked account's posts.
   */
  public async homeTimeline(query: TimelineQuery): Promise<TimelinePage> {
    const result = await this.pools.pool().query<RawPostRow>(
      `
      WITH candidate AS (
        SELECT p.id
          FROM posts p
         WHERE p.account_id = $1
        UNION
        SELECT pa.post_id
          FROM post_audience pa
          JOIN posts p ON p.id = pa.post_id
         WHERE pa.account_id = $1
           AND p.account_id <> $1
        UNION
        SELECT p.id
          FROM posts p
         WHERE p.visibility = 'PUBLIC'
           AND p.account_id <> $1
      )
      SELECT c.*
        FROM (
          SELECT p.id, p.account_id, p.body, p.visibility,
                 p.like_count, p.reply_count, p.repost_count,
                 p.reply_to, p.repost_of, p.edited_at, p.created_at,
                 pr.username, pr.display_name, pr.avatar_key,
                 EXISTS (
                   SELECT 1 FROM post_likes l
                    WHERE l.post_id = p.id AND l.account_id = $1
                 ) AS liked_by_me
            FROM posts p
            JOIN candidate cand ON cand.id = p.id
            JOIN accounts a ON a.id = p.account_id
            JOIN user_profiles pr ON pr.account_id = p.account_id
           WHERE can_view_post(p.id, $1)
             AND ($2::uuid IS NULL OR p.id < $2::uuid)
           ORDER BY p.id DESC
           LIMIT $3
        ) c
      `,
      [query.viewerId, query.cursor, query.limit + 1],
    );

    return toPage(result.rows, query.limit);
  }

  public async authorTimeline(authorId: string, query: TimelineQuery): Promise<TimelinePage> {
    const result = await this.pools.pool().query<RawPostRow>(
      `${SELECT_POSTS}
        WHERE p.account_id = $2
          AND can_view_post(p.id, $1)
          AND ($3::uuid IS NULL OR p.id < $3::uuid)
        ORDER BY p.id DESC
        LIMIT $4`,
      [query.viewerId, authorId, query.cursor, query.limit + 1],
    );

    return toPage(result.rows, query.limit);
  }

  public async setLike(postId: string, accountId: string, liked: boolean): Promise<boolean> {
    if (liked) {
      // Idempotent by primary key: the button can be pressed twice under a flaky
      // connection without inflating the counter.
      await this.pools.pool().query(
        `INSERT INTO post_likes (post_id, account_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [postId, accountId],
      );
      return true;
    }

    await this.pools
      .pool()
      .query('DELETE FROM post_likes WHERE post_id = $1 AND account_id = $2', [postId, accountId]);
    return false;
  }

  public async acceptedFollowerIds(authorId: string): Promise<readonly string[]> {
    const result = await this.pools.pool().query<{ follower_id: string }>(
      `SELECT follower_id FROM follows
        WHERE followee_id = $1 AND accepted_at IS NOT NULL`,
      [authorId],
    );
    return result.rows.map((row) => row.follower_id);
  }

  public async canView(postId: string, viewerId: string): Promise<boolean> {
    const result = await this.pools
      .pool()
      .query<{ visible: boolean }>('SELECT can_view_post($1, $2) AS visible', [postId, viewerId]);
    return result.rows[0]?.visible === true;
  }
}
