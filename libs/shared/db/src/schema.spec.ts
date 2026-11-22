/**
 * Schema invariant tests.
 *
 * These run against a real PostgreSQL server and assert the guarantees the
 * security model depends on. The suite is skipped when TEST_DATABASE_URL is
 * absent, so `pnpm test` stays green on machines without a database.
 */

import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CONNECTION = process.env['TEST_DATABASE_URL'];
const describeWithDb = CONNECTION === undefined ? describe.skip : describe;

let pool: Pool;
let client: PoolClient;

beforeAll(async () => {
  if (CONNECTION === undefined) return;
  pool = new Pool({ connectionString: CONNECTION, max: 1 });
  client = await pool.connect();
});

afterAll(async () => {
  if (CONNECTION === undefined) return;
  client.release();
  await pool.end();
});

/**
 * A category path unique to one test.
 *
 * Migration 0005 seeds `/general` and `/feedback` in every environment, so a test that
 * inserts a fixed path would collide with the fixtures it is not testing.
 */
const uniquePath = (): string => `/${randomUUID().replaceAll('-', '').slice(0, 20)}`;

/** Inserts a scope and returns its id. */
const createScope = async (
  level: string,
  path: string,
  parentId: string | null,
): Promise<string> => {
  const id = randomUUID();
  await client.query(
    'INSERT INTO scopes (id, level, path, name, parent_id) VALUES ($1, $2, $3, $4, $5)',
    [id, level, path, path, parentId],
  );
  return id;
};

const createAccount = async (
  accountType: 'USER' | 'STAFF' | 'ROOT',
  overrides: { state?: string; email?: string; passwordHash?: string } = {},
): Promise<string> => {
  const id = randomUUID();
  const email = (overrides.email ?? `u-${id}@example.test`).toLowerCase();
  await client.query(
    `INSERT INTO accounts (id, account_type, state, email, password_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      accountType,
      overrides.state ?? 'ACTIVE',
      email,
      overrides.passwordHash ?? 'argon2id$dummy',
    ],
  );
  return id;
};

const insertStaffProfile = async (
  accountId: string,
  scopeId: string | null,
  employeeNo: string = `E-${randomUUID()}`,
): Promise<void> => {
  await client.query(
    `INSERT INTO staff_profiles (account_id, employee_no, job_title, primary_scope_id, hired_on)
     VALUES ($1, $2, 'Engineer', $3, current_date)`,
    [accountId, employeeNo, scopeId],
  );
};

/**
 * Creates an internal account together with its HR profile in ONE transaction,
 * mirroring the real provisioning flow: an internal identity can never exist
 * even momentarily without its staff profile.
 */
const createStaffAccount = async (
  accountType: 'STAFF' | 'ROOT',
  scopeId: string | null = null,
): Promise<string> => {
  await client.query('BEGIN');
  try {
    const id = await createAccount(accountType);
    await insertStaffProfile(id, scopeId);
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};

/** Creates a USER account together with its profile, which the graph tables require. */
const createUserWithProfile = async (overrides: { visibility?: string } = {}): Promise<string> => {
  const id = await createAccount('USER');
  await client.query(
    `INSERT INTO user_profiles (account_id, username, display_name, visibility)
     VALUES ($1, $2, $3, $4)`,
    [id, `u_${id.replaceAll('-', '').slice(0, 20)}`, 'Test User', overrides.visibility ?? 'PUBLIC'],
  );
  return id;
};

const follow = async (followerId: string, followeeId: string, accepted = true): Promise<void> => {
  await client.query(
    'INSERT INTO follows (follower_id, followee_id, accepted_at) VALUES ($1, $2, $3)',
    [followerId, followeeId, accepted ? new Date() : null],
  );
};

const countersOf = async (accountId: string): Promise<{ followers: number; following: number }> => {
  const result = await client.query<{ follower_count: number; following_count: number }>(
    'SELECT follower_count, following_count FROM user_profiles WHERE account_id = $1',
    [accountId],
  );
  return {
    followers: result.rows[0]?.follower_count ?? -1,
    following: result.rows[0]?.following_count ?? -1,
  };
};

describeWithDb('messaging schema', () => {
  /**
   * Creates a DIRECT thread with both participants, keyed the way the application
   * keys it: the two ids sorted, so the pair is direction-independent.
   */
  const createDirect = async (a: string, b: string): Promise<string> => {
    const id = randomUUID();
    const dmKey = [a, b].sort().join(':');

    await client.query(
      `INSERT INTO message_threads (id, kind, direct_a_id, direct_b_id, dm_key, owner_id)
       VALUES ($1, 'DIRECT', $2, $3, $4, $2)`,
      [id, a, b, dmKey],
    );
    await client.query(
      `INSERT INTO message_participants (thread_id, account_id) VALUES ($1, $2), ($1, $3)`,
      [id, a, b],
    );
    return id;
  };

  it('allows one direct thread per pair, whichever direction it is created from', async () => {
    const ada = await createUserWithProfile();
    const grace = await createUserWithProfile();
    await createDirect(ada, grace);

    // The second insert is attempted from the other side, which is what a race
    // between two "message" buttons looks like.
    await expect(createDirect(grace, ada)).rejects.toThrow(/message_threads_dm_key|duplicate key/);
  });

  it('rejects a direct thread that points at itself or has no key', async () => {
    const ada = await createUserWithProfile();

    await expect(
      client.query(
        `INSERT INTO message_threads (id, kind, direct_a_id, direct_b_id, dm_key, owner_id)
         VALUES ($1, 'DIRECT', $2, $2, $3, $2)`,
        [randomUUID(), ada, `${ada}:${ada}`],
      ),
    ).rejects.toThrow(/message_threads_shape/);

    await expect(
      client.query(
        `INSERT INTO message_threads (id, kind, direct_a_id, direct_b_id, dm_key, owner_id)
         VALUES ($1, 'DIRECT', $2, $2, NULL, $2)`,
        [randomUUID(), ada],
      ),
    ).rejects.toThrow(/message_threads_shape/);
  });

  it('requires a title on a group and forbids one on a direct thread', async () => {
    const ada = await createUserWithProfile();

    // A group without a title has no name to render in the list.
    await expect(
      client.query(`INSERT INTO message_threads (id, kind, owner_id) VALUES ($1, 'GROUP', $2)`, [
        randomUUID(),
        ada,
      ]),
    ).rejects.toThrow(/message_threads_group_needs_title/);
  });

  it('rejects a blank message and an over-long one', async () => {
    const ada = await createUserWithProfile();
    const grace = await createUserWithProfile();
    const thread = await createDirect(ada, grace);

    await expect(
      client.query(
        `INSERT INTO messages (id, thread_id, sender_id, body) VALUES ($1, $2, $3, '   ')`,
        [randomUUID(), thread, ada],
      ),
    ).rejects.toThrow(/messages_body_not_blank/);

    await expect(
      client.query(
        `INSERT INTO messages (id, thread_id, sender_id, body) VALUES ($1, $2, $3, $4)`,
        [randomUUID(), thread, ada, 'x'.repeat(4_001)],
      ),
    ).rejects.toThrow(/messages_body_len/);
  });

  it('moves the thread summary forward only', async () => {
    const ada = await createUserWithProfile();
    const grace = await createUserWithProfile();
    const thread = await createDirect(ada, grace);

    // The first message always sets the summary: a new thread's last_message_at is
    // `now()`, and a plain `<=` comparison would silently drop it via NULL.
    await client.query(
      `INSERT INTO messages (id, thread_id, sender_id, body) VALUES ($1, $2, $3, 'newest')`,
      [randomUUID(), thread, ada],
    );

    // A backfilled older message must not rewind the inbox ordering.
    await client.query(
      `INSERT INTO messages (id, thread_id, sender_id, body, created_at)
       VALUES ($1, $2, $3, 'backfill', now() - interval '1 day')`,
      [randomUUID(), thread, grace],
    );

    const summary = await client.query<{ last_message_preview: string | null }>(
      'SELECT last_message_preview FROM message_threads WHERE id = $1',
      [thread],
    );
    expect(summary.rows[0]?.last_message_preview).toBe('newest');
  });

  /**
   * A read cursor only advances. An out-of-order event from another device must
   * not mark a message unread again.
   */
  it('never lets a read cursor retreat', async () => {
    const ada = await createUserWithProfile();
    const grace = await createUserWithProfile();
    const thread = await createDirect(ada, grace);

    const first = '0190f3c1-0000-7000-8000-000000000001';
    const second = '0190f3c1-0000-7000-8000-000000000002';

    await client.query(
      'UPDATE message_participants SET last_read_message_id = $1 WHERE thread_id = $2 AND account_id = $3',
      [second, thread, ada],
    );
    await client.query(
      'UPDATE message_participants SET last_read_message_id = $1 WHERE thread_id = $2 AND account_id = $3',
      [first, thread, ada],
    );

    const cursor = await client.query<{ last_read_message_id: string }>(
      'SELECT last_read_message_id FROM message_participants WHERE thread_id = $1 AND account_id = $2',
      [thread, ada],
    );
    expect(cursor.rows[0]?.last_read_message_id).toBe(second);
  });

  it('makes a conversation visible to its members only', async () => {
    const ada = await createUserWithProfile();
    const grace = await createUserWithProfile();
    const outsider = await createUserWithProfile();
    const thread = await createDirect(ada, grace);

    const visible = async (viewer: string | null): Promise<boolean> => {
      const result = await client.query<{ v: boolean }>(
        'SELECT can_view_conversation($1, $2) AS v',
        [thread, viewer],
      );
      return result.rows[0]?.v === true;
    };

    expect(await visible(ada)).toBe(true);
    expect(await visible(grace)).toBe(true);
    expect(await visible(outsider)).toBe(false);
    // No viewer means no answer, and false is the only safe default.
    expect(await visible(null)).toBe(false);
  });

  /** A block ends the conversation in both directions, history included. */
  it('hides the conversation from both parties after a block', async () => {
    const ada = await createUserWithProfile();
    const grace = await createUserWithProfile();
    const thread = await createDirect(ada, grace);

    await client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [grace, ada]);

    const visible = async (viewer: string): Promise<boolean> => {
      const result = await client.query<{ v: boolean }>(
        'SELECT can_view_conversation($1, $2) AS v',
        [thread, viewer],
      );
      return result.rows[0]?.v === true;
    };

    // The blocker loses access too: keeping a channel they closed is not a feature.
    expect(await visible(grace)).toBe(false);
    expect(await visible(ada)).toBe(false);
  });

  /**
   * In a group the rule is per-viewer, not global: a block between two *other*
   * members must not silence the conversation for a bystander, but neither party
   * to the block keeps access -- and a group is not a way around a block.
   */
  it('hides a group from each side of a block, and only from them', async () => {
    const owner = await createUserWithProfile();
    const member = await createUserWithProfile();
    const blocked = await createUserWithProfile();

    const thread = randomUUID();
    await client.query(
      `INSERT INTO message_threads (id, kind, owner_id, title) VALUES ($1, 'GROUP', $2, 'Release planning')`,
      [thread, owner],
    );
    for (const account of [owner, member, blocked]) {
      await client.query(
        'INSERT INTO message_participants (thread_id, account_id) VALUES ($1, $2)',
        [thread, account],
      );
    }

    const visible = async (viewer: string): Promise<boolean> => {
      const result = await client.query<{ v: boolean }>(
        'SELECT can_view_conversation($1, $2) AS v',
        [thread, viewer],
      );
      return result.rows[0]?.v === true;
    };

    expect(await visible(member)).toBe(true);

    await client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
      owner,
      blocked,
    ]);

    // Both parties to the block lose the group; the uninvolved member keeps it.
    expect(await visible(owner)).toBe(false);
    expect(await visible(blocked)).toBe(false);
    expect(await visible(member)).toBe(true);
  });

  it('drops a member who left out of the visibility check', async () => {
    const ada = await createUserWithProfile();
    const grace = await createUserWithProfile();
    const thread = await createDirect(ada, grace);

    await client.query(
      'UPDATE message_participants SET left_at = now() WHERE thread_id = $1 AND account_id = $2',
      [thread, grace],
    );

    const result = await client.query<{ v: boolean }>('SELECT can_view_conversation($1, $2) AS v', [
      thread,
      grace,
    ]);
    expect(result.rows[0]?.v).toBe(false);

    // The remaining participant keeps the thread.
    const still = await client.query<{ v: boolean }>('SELECT can_view_conversation($1, $2) AS v', [
      thread,
      ada,
    ]);
    expect(still.rows[0]?.v).toBe(true);
  });
});

describeWithDb('blog schema', () => {
  /** An article row with everything the constraints require already valid. */
  const createArticle = async (
    overrides: Partial<{
      id: string;
      author: string;
      slug: string;
      status: string;
      publishedAt: Date | null;
      scheduledFor: Date | null;
    }> = {},
  ): Promise<string> => {
    const id = overrides.id ?? randomUUID();
    const author = overrides.author ?? (await createUserWithProfile());

    await client.query(
      `INSERT INTO articles
         (id, author_id, slug, title, body, excerpt, reading_minutes,
          status, published_at, scheduled_for)
       VALUES ($1, $2, $3, 'A perfectly reasonable title', 'The body of the article.',
               'The body of the article.', 1, $4, $5, $6)`,
      [
        id,
        author,
        overrides.slug ?? `slug-${id.slice(-12)}`,
        overrides.status ?? 'DRAFT',
        overrides.publishedAt ?? null,
        overrides.scheduledFor ?? null,
      ],
    );

    return id;
  };

  it('allows one article per slug', async () => {
    const author = await createUserWithProfile();
    await createArticle({ author, slug: 'the-same-url' });

    await expect(createArticle({ author, slug: 'the-same-url' })).rejects.toThrow(
      /articles_slug_key|duplicate key/,
    );
  });

  it('rejects a slug that is not URL-shaped', async () => {
    const author = await createUserWithProfile();
    for (const slug of ['Has Upper', 'double--hyphen', '-leading', 'ab', 'under_score']) {
      await expect(createArticle({ author, slug })).rejects.toThrow(/articles_slug_shape/);
    }
  });

  it('rejects a blank body, an over-long body and a title outside the window', async () => {
    const author = await createUserWithProfile();

    await expect(
      client.query(
        `INSERT INTO articles (id, author_id, slug, title, body, excerpt, reading_minutes)
         VALUES ($1, $2, $3, 'A valid title here', '   ', 'x', 1)`,
        [randomUUID(), author, `blank-${randomUUID().slice(-8)}`],
      ),
    ).rejects.toThrow(/articles_body_not_blank/);

    await expect(
      client.query(
        `INSERT INTO articles (id, author_id, slug, title, body, excerpt, reading_minutes)
         VALUES ($1, $2, $3, 'A valid title here', $4, 'x', 1)`,
        [randomUUID(), author, `long-${randomUUID().slice(-8)}`, 'x'.repeat(100_001)],
      ),
    ).rejects.toThrow(/articles_body_len/);

    await expect(
      client.query(
        `INSERT INTO articles (id, author_id, slug, title, body, excerpt, reading_minutes)
         VALUES ($1, $2, $3, 'ab', 'body', 'x', 1)`,
        [randomUUID(), author, `short-${randomUUID().slice(-8)}`],
      ),
    ).rejects.toThrow(/articles_title_len/);
  });

  /** A schedule without a moment is unanswerable; a moment without a schedule is a lie. */
  it('pairs the schedule status with its timestamp in both directions', async () => {
    const author = await createUserWithProfile();

    await expect(
      createArticle({ author, status: 'SCHEDULED', scheduledFor: null }),
    ).rejects.toThrow(/articles_schedule_pairing/);
    await expect(
      createArticle({ author, status: 'DRAFT', scheduledFor: new Date('2027-01-01T00:00:00Z') }),
    ).rejects.toThrow(/articles_schedule_pairing/);
  });

  it('requires a date on anything a reader can reach', async () => {
    const author = await createUserWithProfile();
    await expect(createArticle({ author, status: 'PUBLISHED', publishedAt: null })).rejects.toThrow(
      /articles_published_dated/,
    );
  });

  it('makes a published article readable, and a draft readable only by its author', async () => {
    const author = await createUserWithProfile();
    const stranger = await createUserWithProfile();

    const draft = await createArticle({ author });
    const live = await createArticle({ author, status: 'PUBLISHED', publishedAt: new Date() });

    const canSee = async (article: string, viewer: string): Promise<boolean> => {
      const result = await client.query<{ v: boolean }>('SELECT can_view_article($1, $2) AS v', [
        article,
        viewer,
      ]);
      return result.rows[0]?.v === true;
    };

    expect(await canSee(draft, author)).toBe(true);
    expect(await canSee(draft, stranger)).toBe(false);
    expect(await canSee(live, stranger)).toBe(true);
    expect(await canSee(live, author)).toBe(true);
    // No viewer means no answer, and false is the only safe default.
    expect(await canSee(live, null as unknown as string)).toBe(false);
  });

  /**
   * The clock is the authority for a schedule, not a worker: an article due a minute ago
   * is readable even though nothing has flipped its status.
   */
  it('publishes a scheduled article when it is due, without changing its status', async () => {
    const author = await createUserWithProfile();
    const reader = await createUserWithProfile();
    const due = await createArticle({
      author,
      status: 'SCHEDULED',
      scheduledFor: new Date(Date.now() - 60_000),
    });
    const future = await createArticle({
      author,
      status: 'SCHEDULED',
      scheduledFor: new Date(Date.now() + 86_400_000),
    });

    const canSee = async (article: string): Promise<boolean> => {
      const result = await client.query<{ v: boolean }>('SELECT can_view_article($1, $2) AS v', [
        article,
        reader,
      ]);
      return result.rows[0]?.v === true;
    };

    expect(await canSee(due)).toBe(true);
    expect(await canSee(future)).toBe(false);

    const stored = await client.query<{ status: string }>(
      'SELECT status FROM articles WHERE id = $1',
      [due],
    );
    expect(stored.rows[0]?.status).toBe('SCHEDULED');
  });

  it('hides an archived article from a reader but not from its author', async () => {
    const author = await createUserWithProfile();
    const reader = await createUserWithProfile();
    const archived = await createArticle({
      author,
      status: 'ARCHIVED',
      publishedAt: new Date(),
    });

    const canSee = async (viewer: string): Promise<boolean> => {
      const result = await client.query<{ v: boolean }>('SELECT can_view_article($1, $2) AS v', [
        archived,
        viewer,
      ]);
      return result.rows[0]?.v === true;
    };

    expect(await canSee(reader)).toBe(false);
    expect(await canSee(author)).toBe(true);
  });

  /**
   * A block hides a published article from the reader, in either direction — the same
   * rule `can_view_post()` applies.
   *
   * The author keeps reading their own article: a block between the author and one
   * reader is not the author's to observe, and losing access to your own work because a
   * stranger blocked you would be a lever, not a protection.
   */
  it('hides a published article from the blocked reader, not from its author', async () => {
    const author = await createUserWithProfile();
    const reader = await createUserWithProfile();
    const article = await createArticle({
      author,
      status: 'PUBLISHED',
      publishedAt: new Date(),
    });

    await client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
      reader,
      author,
    ]);

    const canSee = async (viewer: string): Promise<boolean> => {
      const result = await client.query<{ v: boolean }>('SELECT can_view_article($1, $2) AS v', [
        article,
        viewer,
      ]);
      return result.rows[0]?.v === true;
    };

    expect(await canSee(reader)).toBe(false);
    expect(await canSee(author)).toBe(true);
  });

  /** The author keeps access to their own unpublished work regardless of any block. */
  it('keeps a draft readable by its author even after a block', async () => {
    const author = await createUserWithProfile();
    const reader = await createUserWithProfile();
    const draft = await createArticle({ author });

    await client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
      reader,
      author,
    ]);

    const canSee = async (viewer: string): Promise<boolean> => {
      const result = await client.query<{ v: boolean }>('SELECT can_view_article($1, $2) AS v', [
        draft,
        viewer,
      ]);
      return result.rows[0]?.v === true;
    };

    expect(await canSee(author)).toBe(true);
    expect(await canSee(reader)).toBe(false);
  });

  it('rejects a malformed tag and a duplicate tag on one article', async () => {
    const author = await createUserWithProfile();
    const article = await createArticle({ author });

    await client.query('INSERT INTO article_tags (article_id, tag) VALUES ($1, $2)', [
      article,
      'postgresql',
    ]);

    await expect(
      client.query('INSERT INTO article_tags (article_id, tag) VALUES ($1, $2)', [
        article,
        'postgresql',
      ]),
    ).rejects.toThrow(/duplicate key|article_tags_pkey/);

    for (const tag of ['Upper', 'two--hyphens', '-leading', 'with space']) {
      await expect(
        client.query('INSERT INTO article_tags (article_id, tag) VALUES ($1, $2)', [article, tag]),
      ).rejects.toThrow(/article_tags_shape/);
    }
  });

  it('deletes the tags with the article', async () => {
    const author = await createUserWithProfile();
    const article = await createArticle({ author });
    await client.query('INSERT INTO article_tags (article_id, tag) VALUES ($1, $2)', [
      article,
      'cleanup',
    ]);

    await client.query('DELETE FROM articles WHERE id = $1', [article]);

    const remaining = await client.query<{ count: string }>(
      'SELECT count(*)::text FROM article_tags WHERE article_id = $1',
      [article],
    );
    expect(remaining.rows[0]?.count).toBe('0');
  });
});

describeWithDb('notifications, quiz and forum schema', () => {
  it('rejects an unknown notification kind', async () => {
    const recipient = await createUserWithProfile();
    const actor = await createUserWithProfile();

    await expect(
      client.query(
        `INSERT INTO notifications (id, recipient_id, kind, actor_id, group_key)
         VALUES ($1, $2, 'POKE', $3, 'x')`,
        [randomUUID(), recipient, actor],
      ),
    ).rejects.toThrow(/notifications_kind_allowed/);
  });

  /**
   * Collapsing is a storage concern: one row per (recipient, group_key) is what
   * stops a viral post from creating thousands of rows.
   */
  it('collapses repeat notifications for the same group', async () => {
    const recipient = await createUserWithProfile();
    const actor = await createUserWithProfile();

    await client.query(
      `INSERT INTO notifications (id, recipient_id, kind, actor_id, group_key, actor_count)
       VALUES ($1, $2, 'LIKE', $3, 'like:post-1', 1)`,
      [randomUUID(), recipient, actor],
    );

    await expect(
      client.query(
        `INSERT INTO notifications (id, recipient_id, kind, actor_id, group_key)
         VALUES ($1, $2, 'LIKE', $3, 'like:post-1')`,
        [randomUUID(), recipient, actor],
      ),
    ).rejects.toThrow(/notifications_group_key|duplicate key/);
  });

  it('bounds the recent-actor array', async () => {
    const recipient = await createUserWithProfile();
    const actor = await createUserWithProfile();
    const tooMany = Array.from({ length: 6 }, () => randomUUID());

    await expect(
      client.query(
        `INSERT INTO notifications (id, recipient_id, kind, actor_id, group_key, recent_actor_ids)
         VALUES ($1, $2, 'LIKE', $3, 'g', $4::uuid[])`,
        [randomUUID(), recipient, actor, tooMany],
      ),
    ).rejects.toThrow(/notifications_recent_actors_bounded/);
  });

  it('requires quiz titles and question positions to be sane', async () => {
    const owner = await createUserWithProfile();

    await expect(
      client.query(`INSERT INTO quiz_sets (id, owner_id, title) VALUES ($1, $2, '   ')`, [
        randomUUID(),
        owner,
      ]),
    ).rejects.toThrow(/quiz_sets_title_len/);

    const setId = randomUUID();
    await client.query(
      `INSERT INTO quiz_sets (id, owner_id, title) VALUES ($1, $2, 'Algebra basics')`,
      [setId, owner],
    );

    await client.query(
      `INSERT INTO quiz_questions (id, set_id, prompt, position) VALUES ($1, $2, 'What is 2+2?', 1)`,
      [randomUUID(), setId],
    );
    // Two questions cannot claim the same slot, or "question 2 of 5" is ambiguous.
    await expect(
      client.query(
        `INSERT INTO quiz_questions (id, set_id, prompt, position) VALUES ($1, $2, 'Again?', 1)`,
        [randomUUID(), setId],
      ),
    ).rejects.toThrow(/quiz_questions_position_unique|duplicate key/);
  });

  it('rejects an attempt whose score exceeds its maximum', async () => {
    const owner = await createUserWithProfile();
    const student = await createUserWithProfile();
    const setId = randomUUID();
    await client.query(`INSERT INTO quiz_sets (id, owner_id, title) VALUES ($1, $2, 'Set')`, [
      setId,
      owner,
    ]);

    await expect(
      client.query(
        `INSERT INTO quiz_attempts (id, set_id, account_id, score, max_score, submitted_at)
         VALUES ($1, $2, $3, 11, 10, now())`,
        [randomUUID(), setId, student],
      ),
    ).rejects.toThrow(/quiz_attempts_score_range/);
  });

  it('counts attempts and thread answers from the rows', async () => {
    const owner = await createUserWithProfile();
    const student = await createUserWithProfile();
    const setId = randomUUID();
    await client.query(`INSERT INTO quiz_sets (id, owner_id, title) VALUES ($1, $2, 'Counted')`, [
      setId,
      owner,
    ]);
    await client.query(`INSERT INTO quiz_attempts (id, set_id, account_id) VALUES ($1, $2, $3)`, [
      randomUUID(),
      setId,
      student,
    ]);

    const counted = await client.query<{ attempt_count: number }>(
      'SELECT attempt_count FROM quiz_sets WHERE id = $1',
      [setId],
    );
    expect(counted.rows[0]?.attempt_count).toBe(1);

    const categoryId = randomUUID();
    const slug = randomUUID().replaceAll('-', '').slice(0, 20);
    const path = uniquePath();
    await client.query(
      `INSERT INTO forum_categories (id, slug, name, path) VALUES ($1, $2, 'General', $3)`,
      [categoryId, slug, path],
    );
    const threadId = randomUUID();
    await client.query(
      `INSERT INTO forum_threads (id, category_id, author_id, title, body)
       VALUES ($1, $2, $3, 'A thread title', 'The body')`,
      [threadId, categoryId, owner],
    );
    await client.query(
      `INSERT INTO forum_answers (id, thread_id, author_id, body) VALUES ($1, $2, $3, 'An answer')`,
      [randomUUID(), threadId, student],
    );

    const thread = await client.query<{ answer_count: number }>(
      'SELECT answer_count FROM forum_threads WHERE id = $1',
      [threadId],
    );
    expect(thread.rows[0]?.answer_count).toBe(1);
  });

  it('allows at most one accepted answer per thread', async () => {
    const owner = await createUserWithProfile();
    const categoryId = randomUUID();
    const slug = randomUUID().replaceAll('-', '').slice(0, 20);
    const path = uniquePath();
    await client.query(
      `INSERT INTO forum_categories (id, slug, name, path) VALUES ($1, $2, 'Help', $3)`,
      [categoryId, slug, path],
    );
    const threadId = randomUUID();
    await client.query(
      `INSERT INTO forum_threads (id, category_id, author_id, title, body)
       VALUES ($1, $2, $3, 'Need help', 'Please')`,
      [threadId, categoryId, owner],
    );

    for (let index = 0; index < 2; index += 1) {
      await client
        .query(
          `INSERT INTO forum_answers (id, thread_id, author_id, body, accepted_at)
         VALUES ($1, $2, $3, 'Answer', now())`,
          [randomUUID(), threadId, owner],
        )
        .catch((error: Error) => {
          expect(error.message).toMatch(/forum_answers_one_accepted|duplicate key/);
        });
    }

    const accepted = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM forum_answers WHERE thread_id = $1 AND accepted_at IS NOT NULL',
      [threadId],
    );
    expect(accepted.rows[0]?.n).toBe('1');
  });

  /**
   * Quiz visibility mirrors post visibility, minus the audience snapshot: a set
   * has a live visibility, not an addressed one.
   */
  it('enforces quiz set visibility', async () => {
    const owner = await createUserWithProfile();
    const follower = await createUserWithProfile();
    const stranger = await createUserWithProfile();
    const setId = randomUUID();

    await client.query(
      `INSERT INTO quiz_sets (id, owner_id, title, visibility)
       VALUES ($1, $2, 'Followers only', 'FOLLOWERS')`,
      [setId, owner],
    );

    const visible = async (viewer: string): Promise<boolean> => {
      const result = await client.query<{ v: boolean }>('SELECT can_view_quiz_set($1, $2) AS v', [
        setId,
        viewer,
      ]);
      return result.rows[0]?.v === true;
    };

    expect(await visible(owner)).toBe(true);
    expect(await visible(stranger)).toBe(false);

    await follow(follower, owner);
    expect(await visible(follower)).toBe(true);

    await client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
      owner,
      follower,
    ]);
    // The block severs the follow by trigger, and the visibility check denies too.
    expect(await visible(follower)).toBe(false);
  });

  it('hides a forum thread across a block, in both directions', async () => {
    const author = await createUserWithProfile();
    const reader = await createUserWithProfile();
    const categoryId = randomUUID();
    const slug = randomUUID().replaceAll('-', '').slice(0, 20);
    const path = uniquePath();
    await client.query(
      `INSERT INTO forum_categories (id, slug, name, path) VALUES ($1, $2, 'Talk', $3)`,
      [categoryId, slug, path],
    );
    const threadId = randomUUID();
    await client.query(
      `INSERT INTO forum_threads (id, category_id, author_id, title, body)
       VALUES ($1, $2, $3, 'Visible to all', 'Except one')`,
      [threadId, categoryId, author],
    );

    const visible = async (viewer: string): Promise<boolean> => {
      const result = await client.query<{ v: boolean }>('SELECT can_view_thread($1, $2) AS v', [
        threadId,
        viewer,
      ]);
      return result.rows[0]?.v === true;
    };

    expect(await visible(reader)).toBe(true);

    await client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
      author,
      reader,
    ]);
    expect(await visible(reader)).toBe(false);
  });

  it('rejects a malformed forum category path', async () => {
    await expect(
      client.query(
        `INSERT INTO forum_categories (id, slug, name, path)
         VALUES ($1, 'Talk Space', 'Talk', 'not-a-path')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/forum_categories_(slug|path)_shape/);
  });
});

describeWithDb('feed schema', () => {
  /** Inserts a post directly, so the test controls visibility and audience. */
  const createPost = async (
    authorId: string,
    overrides: {
      body?: string;
      visibility?: string;
      replyTo?: string | null;
      repostOf?: string | null;
      audience?: readonly string[];
    } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await client.query(
      `INSERT INTO posts (id, account_id, body, visibility, reply_to, repost_of)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        authorId,
        overrides.body ?? 'hello world',
        overrides.visibility ?? 'PUBLIC',
        overrides.replyTo ?? null,
        overrides.repostOf ?? null,
      ],
    );
    for (const viewer of overrides.audience ?? []) {
      await client.query('INSERT INTO post_audience (post_id, account_id) VALUES ($1, $2)', [
        id,
        viewer,
      ]);
    }
    return id;
  };

  const canView = async (postId: string, viewerId: string | null): Promise<boolean> => {
    const result = await client.query<{ visible: boolean }>(
      'SELECT can_view_post($1, $2) AS visible',
      [postId, viewerId],
    );
    return result.rows[0]?.visible === true;
  };

  it('rejects blank and unbounded post bodies', async () => {
    const author = await createUserWithProfile();
    await expect(createPost(author, { body: '   ' })).rejects.toThrow(/posts_body_not_blank/);
    await expect(createPost(author, { body: 'x'.repeat(5001) })).rejects.toThrow(/posts_body_len/);
  });

  it('rejects an unknown post visibility', async () => {
    const author = await createUserWithProfile();
    await expect(createPost(author, { visibility: 'FRIENDS' })).rejects.toThrow(
      /posts_visibility_allowed/,
    );
  });

  it('refuses to let a post reference itself', async () => {
    const author = await createUserWithProfile();
    const id = randomUUID();
    await expect(
      client.query(`INSERT INTO posts (id, account_id, body, reply_to) VALUES ($1, $2, 'x', $1)`, [
        id,
        author,
      ]),
    ).rejects.toThrow(/posts_not_self_reply/);
  });

  it('makes a public post visible to anyone, and hidden from nobody', async () => {
    const author = await createUserWithProfile();
    const stranger = await createUserWithProfile();
    const post = await createPost(author, { visibility: 'PUBLIC' });

    expect(await canView(post, stranger)).toBe(true);
    expect(await canView(post, author)).toBe(true);
  });

  it('shows a FOLLOWERS post only to accepted followers', async () => {
    const author = await createUserWithProfile();
    const follower = await createUserWithProfile();
    const stranger = await createUserWithProfile();
    const post = await createPost(author, { visibility: 'FOLLOWERS' });

    expect(await canView(post, stranger)).toBe(false);

    await follow(follower, author, false); // pending request: not an edge yet
    expect(await canView(post, follower)).toBe(false);

    await client.query(
      'UPDATE follows SET accepted_at = now() WHERE follower_id = $1 AND followee_id = $2',
      [follower, author],
    );
    expect(await canView(post, follower)).toBe(true);
  });

  it('keeps a private post to its author', async () => {
    const author = await createUserWithProfile();
    const follower = await createUserWithProfile();
    const post = await createPost(author, { visibility: 'PRIVATE' });

    await follow(follower, author);
    expect(await canView(post, follower)).toBe(false);
    expect(await canView(post, author)).toBe(true);
  });

  /**
   * A block must defeat a live follow. This is the same ordering as the profile
   * rules, and the reason it is tested here as well is that the feed reads
   * through SQL, not through the service.
   */
  it('hides a post across a block, even from a follower', async () => {
    const author = await createUserWithProfile();
    const follower = await createUserWithProfile();
    const post = await createPost(author, { visibility: 'PUBLIC' });

    await follow(follower, author);
    expect(await canView(post, follower)).toBe(true);

    await client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
      author,
      follower,
    ]);
    expect(await canView(post, follower)).toBe(false);
    // The block is symmetric: the author loses sight of the blocked party's view
    // of their own post, and the blocked party sees nothing either way.
    expect(await canView(post, author)).toBe(true);
  });

  it('hides a reply when the parent is not visible', async () => {
    const author = await createUserWithProfile();
    const stranger = await createUserWithProfile();

    const parent = await createPost(author, { visibility: 'PRIVATE' });
    const reply = await createPost(author, { visibility: 'PUBLIC', replyTo: parent });

    // The reply is public, but replying to a private thread would leak that
    // thread's content through the reply text.
    expect(await canView(reply, stranger)).toBe(false);
    expect(await canView(reply, author)).toBe(true);
  });

  it('treats a missing post and an anonymous viewer as not visible', async () => {
    const author = await createUserWithProfile();
    const post = await createPost(author);

    expect(await canView(randomUUID(), author)).toBe(false);
    expect(await canView(post, null)).toBe(false);
  });

  it('counts likes once per account and never below zero', async () => {
    const author = await createUserWithProfile();
    const liker = await createUserWithProfile();
    const post = await createPost(author);

    await client.query('INSERT INTO post_likes (post_id, account_id) VALUES ($1, $2)', [
      post,
      liker,
    ]);
    await expect(
      client.query('INSERT INTO post_likes (post_id, account_id) VALUES ($1, $2)', [post, liker]),
    ).rejects.toThrow(/duplicate key/);

    const counted = await client.query<{ like_count: number }>(
      'SELECT like_count FROM posts WHERE id = $1',
      [post],
    );
    expect(counted.rows[0]?.like_count).toBe(1);

    await client.query('DELETE FROM post_likes WHERE post_id = $1 AND account_id = $2', [
      post,
      liker,
    ]);
    const after = await client.query<{ like_count: number }>(
      'SELECT like_count FROM posts WHERE id = $1',
      [post],
    );
    expect(after.rows[0]?.like_count).toBe(0);
  });

  it('counts replies and reposts from the rows', async () => {
    const author = await createUserWithProfile();
    const parent = await createPost(author);

    await createPost(author, { replyTo: parent });
    const reposted = await createPost(await createUserWithProfile(), { repostOf: parent });

    const counted = await client.query<{ reply_count: number; repost_count: number }>(
      'SELECT reply_count, repost_count FROM posts WHERE id = $1',
      [parent],
    );
    expect(counted.rows[0]).toEqual({ reply_count: 1, repost_count: 1 });
    expect(reposted).not.toBe(parent);
  });

  /**
   * The audience table is the consent record for FOLLOWERS visibility: it must
   * be a snapshot, not a live join. A follower who arrives after publication is
   * not in the audience and therefore does not receive the post in their
   * timeline.
   */
  it('does not add a later follower to an existing audience', async () => {
    const author = await createUserWithProfile();
    const early = await createUserWithProfile();
    const late = await createUserWithProfile();

    await follow(early, author);
    const post = await createPost(author, { visibility: 'FOLLOWERS', audience: [early] });

    await follow(late, author);

    const { rows } = await client.query<{ account_id: string }>(
      'SELECT account_id FROM post_audience WHERE post_id = $1',
      [post],
    );
    expect(rows.map((row) => row.account_id)).toEqual([early]);
  });

  it('removes audience rows and likes when the post is deleted', async () => {
    const author = await createUserWithProfile();
    const follower = await createUserWithProfile();

    await follow(follower, author);
    const post = await createPost(author, { visibility: 'FOLLOWERS', audience: [follower] });
    await client.query('INSERT INTO post_likes (post_id, account_id) VALUES ($1, $2)', [
      post,
      follower,
    ]);

    await client.query('DELETE FROM posts WHERE id = $1', [post]);

    const audience = await client.query('SELECT 1 FROM post_audience WHERE post_id = $1', [post]);
    const likes = await client.query('SELECT 1 FROM post_likes WHERE post_id = $1', [post]);
    expect(audience.rowCount).toBe(0);
    expect(likes.rowCount).toBe(0);
  });
});

describeWithDb('social graph schema', () => {
  it('defaults a new profile to PUBLIC visibility', async () => {
    const id = await createUserWithProfile();
    const result = await client.query<{ visibility: string }>(
      'SELECT visibility FROM user_profiles WHERE account_id = $1',
      [id],
    );
    expect(result.rows[0]?.visibility).toBe('PUBLIC');
  });

  it('rejects an unknown profile visibility', async () => {
    const id = await createAccount('USER');
    await expect(
      client.query(
        `INSERT INTO user_profiles (account_id, username, display_name, visibility)
         VALUES ($1, $2, 'Test', 'SECRET')`,
        [id, `v_${id.replaceAll('-', '').slice(0, 20)}`],
      ),
    ).rejects.toThrow(/user_profiles_visibility_allowed/);
  });

  it('refuses a self-follow', async () => {
    const a = await createUserWithProfile();
    await expect(follow(a, a)).rejects.toThrow(/follows_no_self_edge/);
  });

  it('treats a duplicate follow as a no-op rather than an error', async () => {
    const a = await createUserWithProfile();
    const b = await createUserWithProfile();
    await follow(a, b);
    // The composite primary key makes idempotency a property of the schema, so
    // the API does not need a read-then-write race to implement it.
    await expect(
      client.query(
        `INSERT INTO follows (follower_id, followee_id, accepted_at) VALUES ($1, $2, now())
         ON CONFLICT DO NOTHING`,
        [a, b],
      ),
    ).resolves.toBeDefined();
    expect((await countersOf(b)).followers).toBe(1);
  });

  it('maintains follower and following counters from the edge table', async () => {
    const a = await createUserWithProfile();
    const b = await createUserWithProfile();

    await follow(a, b);
    expect(await countersOf(b)).toEqual({ followers: 1, following: 0 });
    expect(await countersOf(a)).toEqual({ followers: 0, following: 1 });

    await client.query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [a, b]);
    expect(await countersOf(b)).toEqual({ followers: 0, following: 0 });
  });

  it('does not count a pending follow request as a follower', async () => {
    const a = await createUserWithProfile();
    const b = await createUserWithProfile({ visibility: 'PRIVATE' });

    await follow(a, b, false);
    expect((await countersOf(b)).followers).toBe(0);

    // Accepting the request is what turns it into an edge.
    await client.query(
      'UPDATE follows SET accepted_at = now() WHERE follower_id = $1 AND followee_id = $2',
      [a, b],
    );
    expect((await countersOf(b)).followers).toBe(1);
  });

  /**
   * The block guarantee, at the database level: a block destroys existing follows
   * in both directions. A block that leaves a follow behind keeps delivering the
   * blocked party's content, which is the opposite of what the user asked for.
   */
  it('severs follows in both directions when a block is created', async () => {
    const a = await createUserWithProfile();
    const b = await createUserWithProfile();

    await follow(a, b);
    await follow(b, a);
    expect((await countersOf(b)).followers).toBe(1);

    await client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [a, b]);

    const remaining = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM follows
       WHERE (follower_id = $1 AND followee_id = $2) OR (follower_id = $2 AND followee_id = $1)`,
      [a, b],
    );
    expect(remaining.rows[0]?.n).toBe('0');
    // And the counters were corrected by the same trigger chain.
    expect((await countersOf(b)).followers).toBe(0);
    expect((await countersOf(a)).followers).toBe(0);
  });

  it('refuses a follow that would cross an existing block', async () => {
    const a = await createUserWithProfile();
    const b = await createUserWithProfile();

    await client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [a, b]);

    await expect(follow(a, b)).rejects.toThrow(/cannot follow across a block/);
    // Blocking is symmetric in effect: the blocked party cannot follow either.
    await expect(follow(b, a)).rejects.toThrow(/cannot follow across a block/);
  });

  it('refuses a self-block', async () => {
    const a = await createUserWithProfile();
    await expect(
      client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $1)', [a]),
    ).rejects.toThrow(/blocks_no_self_block/);
  });

  it('allows unblocking, which does not restore the severed follows', async () => {
    const a = await createUserWithProfile();
    const b = await createUserWithProfile();
    await follow(a, b);
    await client.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [a, b]);
    await client.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [a, b]);

    // Re-following after an unblock is the user's decision, not an automatic
    // consequence of removing the block.
    expect((await countersOf(b)).followers).toBe(0);
    await expect(follow(a, b)).resolves.toBeUndefined();
  });
});

describeWithDb('identity schema', () => {
  it('rejects unknown account types and states', async () => {
    await expect(
      client.query(
        `INSERT INTO accounts (id, account_type, state, email) VALUES ($1, 'SUPERUSER', 'ACTIVE', $2)`,
        [randomUUID(), `x-${randomUUID()}@example.test`],
      ),
    ).rejects.toThrow(/account_type_allowed/);

    await expect(
      client.query(
        `INSERT INTO accounts (id, account_type, state, email) VALUES ($1, 'USER', 'GHOST', $2)`,
        [randomUUID(), `y-${randomUUID()}@example.test`],
      ),
    ).rejects.toThrow(/account_state_allowed/);
  });

  it('normalises email case and rejects mixed case at the constraint level', async () => {
    await expect(
      client.query(
        `INSERT INTO accounts (id, account_type, state, email) VALUES ($1, 'USER', 'ACTIVE', 'Mixed@Example.Test')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/accounts_email_is_normalised/);
  });

  it('releases the email of a soft-deleted account but not of an active one', async () => {
    const email = `dup-${randomUUID()}@example.test`;
    const first = await createAccount('USER', { email });
    await expect(createAccount('USER', { email })).rejects.toThrow(/accounts_email_live_key/);

    await client.query('UPDATE accounts SET deleted_at = now(), state = $2 WHERE id = $1', [
      first,
      'SOFT_DELETED',
    ]);
    const second = await createAccount('USER', { email });
    expect(second).not.toBe(first);
  });

  it('requires a staff profile for STAFF and forbids one for USER', async () => {
    // Deferred constraint trigger: the violation surfaces at COMMIT.
    await expect(
      (async () => {
        await client.query('BEGIN');
        await createAccount('STAFF');
        await client.query('COMMIT');
      })(),
    ).rejects.toThrow(/staff_profiles invariant/);
    await client.query('ROLLBACK').catch(() => undefined);

    const staffId = await createStaffAccount('STAFF');
    await expect(insertStaffProfile(staffId, null)).rejects.toThrow(/duplicate key/);
  });

  it('rejects a second ROOT account and protects the existing ROOT row', async () => {
    const first = await createStaffAccount('ROOT');
    const second = await createStaffAccount('ROOT');

    const third = randomUUID();
    await expect(
      client.query(
        `INSERT INTO accounts (id, account_type, state, email) VALUES ($1, 'ROOT', 'ACTIVE', $2)`,
        [third, `root-${third}@example.test`],
      ),
    ).rejects.toThrow(/ROOT account cap/);

    await expect(client.query('DELETE FROM accounts WHERE id = $1', [first])).rejects.toThrow(
      /ROOT accounts cannot be deleted/,
    );
    await expect(
      client.query(`UPDATE accounts SET account_type = 'STAFF' WHERE id = $1`, [first]),
    ).rejects.toThrow(/ROOT accounts cannot be demoted/);

    await client.query('UPDATE accounts SET deleted_at = now() WHERE id IN ($1, $2)', [
      first,
      second,
    ]);
  });

  it('rotates the session epoch when credentials change', async () => {
    const id = await createAccount('USER', { passwordHash: 'argon2id$one' });
    const before = await client.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM accounts WHERE id = $1',
      [id],
    );
    await client.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [
      id,
      'argon2id$two',
    ]);
    const after = await client.query<{ session_epoch: number }>(
      'SELECT session_epoch FROM accounts WHERE id = $1',
      [id],
    );
    expect(after.rows[0]?.session_epoch).toBe((before.rows[0]?.session_epoch ?? 0) + 1);
  });

  it('keeps audit rows immutable', async () => {
    const id = randomUUID();
    // Chain-correct fixture: link to the current head so this test does not
    // introduce a second chain head (which would break verification elsewhere).
    const head = await client.query<{ entry_hash: Buffer }>(
      'SELECT entry_hash FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT 1',
    );
    await client.query(
      `INSERT INTO audit_events (id, action, resource_type, entry_hash, previous_hash)
       VALUES ($1, 'user.login', 'account', $2, $3)`,
      [id, Buffer.alloc(32, 1), head.rows[0]?.entry_hash ?? null],
    );
    await expect(
      client.query(`UPDATE audit_events SET action = 'user.tamper' WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(client.query('DELETE FROM audit_events WHERE id = $1', [id])).rejects.toThrow(
      /append-only/,
    );
  });

  it('rejects malformed scope paths and duplicate employees', async () => {
    const company = await createScope('COMPANY', `/c-${randomUUID().slice(0, 8)}/`, null);
    await expect(
      client.query(
        `INSERT INTO scopes (id, level, path, name) VALUES ($1, 'REGION', 'not-a-path', 'x')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/scopes_path_shape/);

    const employeeNo = `E-${randomUUID()}`;
    const staffA = await createStaffAccount('STAFF', company);
    const staffB = await createStaffAccount('STAFF', company);
    await expect(
      client.query('UPDATE staff_profiles SET employee_no = $2 WHERE account_id = $1', [
        staffA,
        employeeNo,
      ]),
    ).resolves.toBeDefined();
    await expect(insertStaffProfile(staffB, company, employeeNo)).rejects.toThrow(
      /staff_profiles_employee_no_key|duplicate key/,
    );
  });

  it('requires 32-byte digests for verification codes and refresh tokens', async () => {
    const accountId = await createAccount('USER');
    await expect(
      client.query(
        `INSERT INTO verification_codes (id, account_id, purpose, channel, destination_hash, code_digest, expires_at)
         VALUES ($1, $2, 'EMAIL_VERIFY', 'EMAIL', $3, $4, now() + interval '1 hour')`,
        [randomUUID(), accountId, Buffer.alloc(32, 2), Buffer.alloc(16, 3)],
      ),
    ).rejects.toThrow(/verification_codes_digest_len/);

    const sessionId = randomUUID();
    await client.query(
      `INSERT INTO sessions (id, account_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
      [sessionId, accountId],
    );
    await expect(
      client.query(
        `INSERT INTO refresh_tokens (id, session_id, account_id, token_digest, family_id, session_epoch, expires_at)
         VALUES ($1, $2, $3, $4, $2, 0, now() + interval '30 days')`,
        [randomUUID(), sessionId, accountId, Buffer.alloc(31, 4)],
      ),
    ).rejects.toThrow(/refresh_tokens_digest_len/);
  });
});
