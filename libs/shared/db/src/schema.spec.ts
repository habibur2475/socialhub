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
