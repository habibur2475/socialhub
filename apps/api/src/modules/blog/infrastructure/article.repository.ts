/**
 * Blog persistence.
 *
 * Three things are done in SQL rather than in TypeScript:
 *
 *   - **Visibility** is `can_view_article()` in the `WHERE`, so an invisible article is
 *     `null` rather than a row the service had to remember to reject.
 *   - **Tags are aggregated with a `LEFT JOIN LATERAL` + `array_agg`**, not fetched per
 *     article: an archive of 20 articles would otherwise be 20 more queries.
 *   - **A tag replacement is one statement pair inside a transaction** — delete then
 *     insert — because a partial replacement would leave an article tagged with the old
 *     set plus half the new one.
 *
 * The list has two orderings and they are not interchangeable: the public archive sorts
 * by `published_at` (a draft has none), while `mine` sorts by `created_at` (a draft is the
 * most recently worked-on thing its author has). Sorting a draft list by publication date
 * would put every draft at the same, meaningless place.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools, type Queryable } from '../../../database/pool.js';
import type { ArticleStatus } from '@socialhub/kernel';
import type {
  ArticleListQuery,
  ArticlePage,
  ArticleRecord,
  ArticleStore,
  ArticleTagRecord,
} from '../application/ports.js';

type RawArticleRow = {
  id: string;
  author_id: string;
  slug: string;
  title: string;
  body: string;
  excerpt: string;
  reading_minutes: number;
  status: ArticleStatus;
  published_at: Date | null;
  scheduled_for: Date | null;
  created_at: Date;
  updated_at: Date;
  tags: string[] | null;
  username: string;
  display_name: string;
  avatar_key: string | null;
  bio: string | null;
};

const ARTICLE_COLUMNS = `
  a.id, a.author_id, a.slug, a.title, a.body, a.excerpt, a.reading_minutes,
  a.status, a.published_at, a.scheduled_for, a.created_at, a.updated_at,
  (SELECT array_agg(t.tag ORDER BY t.tag)
     FROM article_tags t WHERE t.article_id = a.id) AS tags,
  p.username, p.display_name, p.avatar_key, p.bio`;

const toArticle = (row: RawArticleRow): ArticleRecord => ({
  id: row.id,
  authorId: row.author_id,
  author: {
    accountId: row.author_id,
    username: row.username,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
    bio: row.bio,
  },
  slug: row.slug,
  title: row.title,
  body: row.body,
  excerpt: row.excerpt,
  readingMinutes: row.reading_minutes,
  tags: row.tags ?? [],
  status: row.status,
  publishedAt: row.published_at,
  scheduledFor: row.scheduled_for,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Decodes the keyset cursor: `<ISO instant>|<uuid>`, shared by both orderings. */
const decodeCursor = (cursor: string): { at: string; id: string } | null => {
  const [at, id] = cursor.split('|');
  if (at === undefined || id === undefined) return null;
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return null;
  return { at: parsed.toISOString(), id };
};

@Injectable()
export class PostgresArticleRepository implements ArticleStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  public async list(query: ArticleListQuery): Promise<ArticlePage> {
    const cursor = query.cursor === null ? null : decodeCursor(query.cursor);
    // A cursor that does not decode is treated as the first page: a stale link should
    // show the archive, not a 400.
    const decoded = cursor ?? null;

    // `mine` sorts by work-in-progress; the archive sorts by publication. Both use the
    // id as a tie-breaker, because two rows can share an instant.
    const orderColumn = query.mine ? 'a.created_at' : 'a.published_at';

    const result = await this.pools.pool().query<RawArticleRow>(
      `SELECT ${ARTICLE_COLUMNS}
         FROM articles a
         JOIN user_profiles p ON p.account_id = a.author_id
        WHERE ${
          query.mine
            ? // The caller's own work, in every status: no visibility check needed, and
              // none wanted — a draft is invisible to `can_view_article` for others, not
              // for its author.
              'a.author_id = $1'
            : 'can_view_article(a.id, $1)'
        }
          AND ($2::text IS NULL OR EXISTS (
                SELECT 1 FROM article_tags t WHERE t.article_id = a.id AND t.tag = $2
              ))
          AND ($3::text IS NULL OR p.username = $3)
          AND ($4::timestamptz IS NULL
               OR ${orderColumn} < $4::timestamptz
               OR (${orderColumn} = $4::timestamptz AND a.id < $5::uuid))
        ORDER BY ${orderColumn} DESC NULLS LAST, a.id DESC
        LIMIT $6`,
      [
        query.viewerId,
        query.tag,
        query.authorUsername,
        decoded?.at ?? null,
        decoded?.id ?? null,
        // One extra row answers "is there another page" without a second count.
        query.limit + 1,
      ],
    );

    const rows = result.rows.slice(0, query.limit);
    return { items: rows.map(toArticle), hasMore: result.rows.length > query.limit };
  }

  public async find(viewerId: string, idOrSlug: string): Promise<ArticleRecord | null> {
    // Accepts either an id or a slug: a permalink is a slug, and an edit screen has an
    // id. The clock is not a parameter here because `can_view_article()` asks Postgres
    // for `now()`, which is the same transaction timestamp the whole request sees — a
    // second clock in the service would be a second answer to "is this due?".
    const result = await this.pools.pool().query<RawArticleRow>(
      `SELECT ${ARTICLE_COLUMNS}
         FROM articles a
         JOIN user_profiles p ON p.account_id = a.author_id
        WHERE can_view_article(a.id, $1)
          AND (a.id::text = $2 OR a.slug = $2)
        LIMIT 1`,
      [viewerId, idOrSlug],
    );

    const row = result.rows[0];
    return row === undefined ? null : toArticle(row);
  }

  public async slugTaken(slug: string): Promise<boolean> {
    const result = await this.pools
      .pool()
      .query('SELECT 1 FROM articles WHERE slug = $1 LIMIT 1', [slug]);
    return (result.rowCount ?? 0) > 0;
  }

  public async create(input: {
    readonly id: string;
    readonly authorId: string;
    readonly slug: string;
    readonly title: string;
    readonly body: string;
    readonly excerpt: string;
    readonly readingMinutes: number;
    readonly tags: readonly string[];
  }): Promise<ArticleRecord> {
    await this.pools.transaction(async (client) => {
      await client.query(
        `INSERT INTO articles
           (id, author_id, slug, title, body, excerpt, reading_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.id,
          input.authorId,
          input.slug,
          input.title,
          input.body,
          input.excerpt,
          input.readingMinutes,
        ],
      );

      await this.replaceTags(client, input.id, input.tags);
    });

    return this.readOwn(input.authorId, input.id);
  }

  public async update(input: {
    readonly id: string;
    readonly authorId: string;
    readonly slug: string | null;
    readonly title: string | null;
    readonly body: string | null;
    readonly excerpt: string | null;
    readonly readingMinutes: number | null;
    readonly tags: readonly string[] | null;
  }): Promise<ArticleRecord | null> {
    const assignments: string[] = [];
    const values: unknown[] = [input.id, input.authorId];

    const set = (column: string, value: unknown): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (input.title !== null) set('title', input.title);
    if (input.body !== null) set('body', input.body);
    if (input.excerpt !== null) set('excerpt', input.excerpt);
    if (input.readingMinutes !== null) set('reading_minutes', input.readingMinutes);
    if (input.slug !== null) set('slug', input.slug);

    const updated = await this.pools.transaction(async (client) => {
      // No assignments means only the tags changed, which is a legitimate edit.
      if (assignments.length > 0) {
        const result = await client.query(
          `UPDATE articles SET ${assignments.join(', ')}
            WHERE id = $1 AND author_id = $2
            RETURNING id`,
          values,
        );
        if ((result.rowCount ?? 0) === 0) return false;
      } else {
        const owned = await client.query(
          'SELECT 1 FROM articles WHERE id = $1 AND author_id = $2',
          [input.id, input.authorId],
        );
        if ((owned.rowCount ?? 0) === 0) return false;
      }

      if (input.tags !== null) await this.replaceTags(client, input.id, input.tags);
      return true;
    });

    return updated ? this.readOwn(input.authorId, input.id) : null;
  }

  public async setStatus(input: {
    readonly id: string;
    readonly authorId: string;
    readonly status: ArticleStatus;
    readonly publishedAt: Date | null;
    readonly scheduledFor: Date | null;
  }): Promise<ArticleRecord | null> {
    const result = await this.pools.pool().query(
      `UPDATE articles
          SET status = $3, published_at = $4, scheduled_for = $5
        WHERE id = $1 AND author_id = $2
        RETURNING id`,
      [input.id, input.authorId, input.status, input.publishedAt, input.scheduledFor],
    );

    if ((result.rowCount ?? 0) === 0) return null;
    return this.readOwn(input.authorId, input.id);
  }

  public async delete(id: string, authorId: string): Promise<boolean> {
    const result = await this.pools
      .pool()
      .query('DELETE FROM articles WHERE id = $1 AND author_id = $2', [id, authorId]);
    return (result.rowCount ?? 0) > 0;
  }

  public async listTags(): Promise<readonly ArticleTagRecord[]> {
    // Counted over readable articles only: a tag that exists solely on a draft would
    // either have to be filtered at render time or leak the draft's existence.
    const result = await this.pools.pool().query<{ tag: string; article_count: string }>(
      `SELECT t.tag, count(*)::text AS article_count
         FROM article_tags t
         JOIN articles a ON a.id = t.article_id
        WHERE a.status = 'PUBLISHED'
           OR (a.status = 'SCHEDULED' AND a.scheduled_for IS NOT NULL AND a.scheduled_for <= now())
        GROUP BY t.tag
        ORDER BY count(*) DESC, t.tag`,
    );

    return result.rows.map((row) => ({ tag: row.tag, articleCount: Number(row.article_count) }));
  }

  /** Replaces the tag set atomically; a partial replace is not a state that exists. */
  private async replaceTags(
    client: Queryable,
    articleId: string,
    tags: readonly string[],
  ): Promise<void> {
    await client.query('DELETE FROM article_tags WHERE article_id = $1', [articleId]);

    if (tags.length === 0) return;

    await client.query(
      `INSERT INTO article_tags (article_id, tag)
       SELECT $1::uuid, tag FROM unnest($2::text[]) AS tag
       ON CONFLICT (article_id, tag) DO NOTHING`,
      [articleId, tags],
    );
  }

  /**
   * Reads an article as its own author, bypassing the visibility check.
   *
   * Used only by the write paths, immediately after a write the author just made: the
   * row is theirs by the statement's own `WHERE`, and re-asking `can_view_article` would
   * make a write fail because a reader blocked them.
   */
  private async readOwn(authorId: string, id: string): Promise<ArticleRecord> {
    const result = await this.pools.pool().query<RawArticleRow>(
      `SELECT ${ARTICLE_COLUMNS}
         FROM articles a
         JOIN user_profiles p ON p.account_id = a.author_id
        WHERE a.id = $1`,
      [id],
    );

    const row = result.rows[0];
    if (row === undefined) throw new Error(`article ${id} vanished after a write by ${authorId}`);
    return toArticle(row);
  }
}
