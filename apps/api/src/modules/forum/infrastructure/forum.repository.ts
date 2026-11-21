/**
 * Forum persistence.
 *
 * Thread reads join the category to get its path in the same query, because the path
 * is what a link and a filter use and a second lookup per row is an N+1. The
 * visibility function is applied in the `WHERE`, never after the fact.
 *
 * `has_accepted_answer` is computed with an EXISTS against the partial unique index,
 * which is a single index probe; counting answers and comparing timestamps would be
 * both slower and wrong (an answer can be accepted long after a later one arrives).
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools } from '../../../database/pool.js';
import type {
  ForumAnswerPage,
  ForumAnswerRecord,
  ForumCategoryRecord,
  ForumStore,
  ForumThreadPage,
  ForumThreadRecord,
} from '../application/ports.js';

type RawThreadRow = {
  id: string;
  category_id: string;
  category_path: string;
  author_id: string;
  title: string;
  body: string;
  answer_count: number;
  pinned: boolean;
  locked: boolean;
  has_accepted_answer: boolean;
  created_at: Date;
  updated_at: Date;
  username: string;
  display_name: string;
  avatar_key: string | null;
};

type RawAnswerRow = {
  id: string;
  thread_id: string;
  author_id: string;
  body: string;
  accepted_at: Date | null;
  created_at: Date;
  username: string;
  display_name: string;
  avatar_key: string | null;
};

const SELECT_THREADS = `
  SELECT t.id, t.category_id, c.path AS category_path, t.author_id,
         t.title, t.body, t.answer_count, t.pinned, t.locked,
         EXISTS (
           SELECT 1 FROM forum_answers a
            WHERE a.thread_id = t.id AND a.accepted_at IS NOT NULL
         ) AS has_accepted_answer,
         t.created_at, t.updated_at,
         pr.username, pr.display_name, pr.avatar_key
    FROM forum_threads t
    JOIN forum_categories c ON c.id = t.category_id
    JOIN user_profiles pr ON pr.account_id = t.author_id
`;

const toThread = (row: RawThreadRow): ForumThreadRecord => ({
  id: row.id,
  categoryId: row.category_id,
  categoryPath: row.category_path,
  authorId: row.author_id,
  author: {
    accountId: row.author_id,
    username: row.username,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
  },
  title: row.title,
  body: row.body,
  answerCount: row.answer_count,
  pinned: row.pinned,
  locked: row.locked,
  hasAcceptedAnswer: row.has_accepted_answer,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT_ANSWERS = `
  SELECT a.id, a.thread_id, a.author_id, a.body, a.accepted_at, a.created_at,
         pr.username, pr.display_name, pr.avatar_key
    FROM forum_answers a
    JOIN user_profiles pr ON pr.account_id = a.author_id
`;

const toAnswer = (row: RawAnswerRow): ForumAnswerRecord => ({
  id: row.id,
  threadId: row.thread_id,
  authorId: row.author_id,
  author: {
    accountId: row.author_id,
    username: row.username,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
  },
  body: row.body,
  accepted: row.accepted_at !== null,
  createdAt: row.created_at,
});

@Injectable()
export class PostgresForumRepository implements ForumStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  public async listCategories(): Promise<readonly ForumCategoryRecord[]> {
    const result = await this.pools.pool().query<{
      id: string;
      slug: string;
      name: string;
      path: string;
      thread_count: string;
    }>(
      `SELECT c.id, c.slug, c.name, c.path,
              (SELECT count(*)::text FROM forum_threads t WHERE t.category_id = c.id) AS thread_count
         FROM forum_categories c
        ORDER BY c.path`,
    );

    return result.rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      path: row.path,
      threadCount: Number(row.thread_count),
    }));
  }

  public async findCategoryByPath(path: string): Promise<ForumCategoryRecord | null> {
    const result = await this.pools.pool().query<{
      id: string;
      slug: string;
      name: string;
      path: string;
    }>('SELECT id, slug, name, path FROM forum_categories WHERE path = $1', [path]);

    const row = result.rows[0];
    return row === undefined ? null : { ...row, threadCount: 0 };
  }

  public async findCategoryById(id: string): Promise<ForumCategoryRecord | null> {
    const result = await this.pools.pool().query<{
      id: string;
      slug: string;
      name: string;
      path: string;
    }>('SELECT id, slug, name, path FROM forum_categories WHERE id = $1', [id]);

    const row = result.rows[0];
    return row === undefined ? null : { ...row, threadCount: 0 };
  }

  public async findThread(viewerId: string, threadId: string): Promise<ForumThreadRecord | null> {
    const result = await this.pools
      .pool()
      .query<RawThreadRow>(`${SELECT_THREADS} WHERE t.id = $2 AND can_view_thread(t.id, $1)`, [
        viewerId,
        threadId,
      ]);

    const row = result.rows[0];
    return row === undefined ? null : toThread(row);
  }

  public async listThreads(
    viewerId: string,
    page: { limit: number; cursor: string | null; categoryPath: string | null },
  ): Promise<ForumThreadPage> {
    const result = await this.pools.pool().query<RawThreadRow>(
      `${SELECT_THREADS}
        WHERE can_view_thread(t.id, $1)
          AND ($2::text IS NULL OR c.path = $2 OR c.path LIKE $2 || '/%')
          AND ($3::uuid IS NULL OR t.id < $3::uuid)
        ORDER BY t.pinned DESC, t.id DESC
        LIMIT $4`,
      [viewerId, page.categoryPath, page.cursor, page.limit + 1],
    );

    return {
      items: result.rows.slice(0, page.limit).map(toThread),
      hasMore: result.rows.length > page.limit,
    };
  }

  public async createThread(input: {
    readonly id: string;
    readonly categoryId: string;
    readonly authorId: string;
    readonly title: string;
    readonly body: string;
  }): Promise<ForumThreadRecord | null> {
    const inserted = await this.pools.pool().query<{ id: string }>(
      `INSERT INTO forum_threads (id, category_id, author_id, title, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.id, input.categoryId, input.authorId, input.title, input.body],
    );

    if (inserted.rowCount === 0) return null;
    return this.findThread(input.authorId, input.id);
  }

  public async listAnswers(
    viewerId: string,
    threadId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<ForumAnswerPage> {
    // The `can_view_thread` predicate is repeated here rather than trusted from the
    // caller: an answers route that forgot to check would otherwise serve the
    // contents of a thread its reader is blocked from.
    const visible = await this.pools
      .pool()
      .query<{ v: boolean }>('SELECT can_view_thread($1, $2) AS v', [threadId, viewerId]);
    if (visible.rows[0]?.v !== true) return { items: [], hasMore: false };

    const result = await this.pools.pool().query<RawAnswerRow>(
      `${SELECT_ANSWERS}
        WHERE a.thread_id = $1
          AND ($2::uuid IS NULL OR a.id > $2::uuid)
        ORDER BY a.id
        LIMIT $3`,
      [threadId, page.cursor, page.limit + 1],
    );

    return {
      items: result.rows.slice(0, page.limit).map(toAnswer),
      hasMore: result.rows.length > page.limit,
    };
  }

  public async createAnswer(input: {
    readonly id: string;
    readonly threadId: string;
    readonly authorId: string;
    readonly body: string;
  }): Promise<ForumAnswerRecord | null> {
    // A locked thread refuses new answers in the database, so a caller that races a
    // moderator's lock cannot win by having read `locked = false` a moment earlier.
    const inserted = await this.pools.pool().query<RawAnswerRow>(
      `WITH target AS (
         SELECT t.id FROM forum_threads t
          WHERE t.id = $2 AND NOT t.locked AND can_view_thread(t.id, $3)
       )
       INSERT INTO forum_answers (id, thread_id, author_id, body)
       SELECT $1, target.id, $3, $4 FROM target
       RETURNING id, thread_id, author_id, body, accepted_at, created_at,
                 (SELECT username FROM user_profiles WHERE account_id = $3) AS username,
                 (SELECT display_name FROM user_profiles WHERE account_id = $3) AS display_name,
                 (SELECT avatar_key FROM user_profiles WHERE account_id = $3) AS avatar_key`,
      [input.id, input.threadId, input.authorId, input.body],
    );

    const row = inserted.rows[0];
    return row === undefined ? null : toAnswer(row);
  }

  public async acceptAnswer(input: {
    readonly threadId: string;
    readonly answerId: string;
    readonly threadAuthorId: string;
  }): Promise<ForumAnswerRecord | null> {
    return this.pools.transaction(async (client) => {
      const owns = await client.query<{ ok: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM forum_threads WHERE id = $1 AND author_id = $2) AS ok',
        [input.threadId, input.threadAuthorId],
      );
      if (owns.rows[0]?.ok !== true) return null;

      // Clear first, then set: the partial unique index permits one accepted answer,
      // so updating the new row before clearing the old one collides.
      await client.query(
        'UPDATE forum_answers SET accepted_at = NULL WHERE thread_id = $1 AND accepted_at IS NOT NULL',
        [input.threadId],
      );

      const updated = await client.query<RawAnswerRow>(
        `UPDATE forum_answers SET accepted_at = now()
          WHERE id = $1 AND thread_id = $2
          RETURNING id, thread_id, author_id, body, accepted_at, created_at,
                    (SELECT username FROM user_profiles WHERE account_id = forum_answers.author_id),
                    (SELECT display_name FROM user_profiles WHERE account_id = forum_answers.author_id),
                    (SELECT avatar_key FROM user_profiles WHERE account_id = forum_answers.author_id)`,
        [input.answerId, input.threadId],
      );

      const row = updated.rows[0];
      return row === undefined ? null : toAnswer(row);
    });
  }

  public async canAccept(threadId: string, accountId: string): Promise<boolean> {
    const result = await this.pools.pool().query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM forum_threads t
          WHERE t.id = $1 AND t.author_id = $2 AND NOT t.locked
            AND NOT EXISTS (
              SELECT 1 FROM forum_answers a WHERE a.thread_id = t.id AND a.accepted_at IS NOT NULL
            )
       ) AS ok`,
      [threadId, accountId],
    );
    return result.rows[0]?.ok === true;
  }

  public async threadAuthorId(threadId: string): Promise<string | null> {
    const result = await this.pools.pool().query<{
      author_id: string;
    }>('SELECT author_id FROM forum_threads WHERE id = $1', [threadId]);
    return result.rows[0]?.author_id ?? null;
  }

  public async answerOwner(
    answerId: string,
  ): Promise<{ threadId: string; authorId: string } | null> {
    const result = await this.pools.pool().query<{
      thread_id: string;
      author_id: string;
    }>('SELECT thread_id, author_id FROM forum_answers WHERE id = $1', [answerId]);

    const row = result.rows[0];
    return row === undefined ? null : { threadId: row.thread_id, authorId: row.author_id };
  }

  public async deleteAnswer(answerId: string, accountId: string): Promise<boolean> {
    const result = await this.pools
      .pool()
      .query('DELETE FROM forum_answers WHERE id = $1 AND author_id = $2', [answerId, accountId]);
    return (result.rowCount ?? 0) > 0;
  }

  public async isThreadLocked(threadId: string): Promise<boolean> {
    const result = await this.pools
      .pool()
      .query<{ locked: boolean }>('SELECT locked FROM forum_threads WHERE id = $1', [threadId]);
    return result.rows[0]?.locked === true;
  }
}
