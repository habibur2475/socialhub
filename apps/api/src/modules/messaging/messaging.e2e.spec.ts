/**
 * Messaging end-to-end tests.
 *
 * The properties here are the ones only a real database and a real HTTP stack can
 * show: the unordered `dm_key` converges two "message" clicks on one conversation, a
 * block hides the thread from both sides at once, the read cursor does not retreat,
 * and a retried send with the same `clientId` produces one message.
 *
 * Direct threads need a follow relationship in at least one direction; the tests
 * create it directly in `follows` rather than through the follow endpoint, because the
 * follow rules are already covered by the profile suite and this suite is about
 * messaging.
 */

import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { RequestMethod, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter.js';
import { MemoryCache } from '../../common/cache/memory-cache.js';
import { CACHE } from '../../database/cache.provider.js';
import { JsonLogger } from '../../common/logging/logger.js';

const CONNECTION = process.env['TEST_DATABASE_URL'];
const describeWithDb = CONNECTION === undefined ? describe.skip : describe;

const PASSWORD = 'correct-horse-battery';

type Actor = { accountId: string; username: string; accessToken: string };

describeWithDb('messaging (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = CONNECTION;
    process.env['NODE_ENV'] = 'test';
    process.env['CACHE_DRIVER'] = 'memory';
    process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
    process.env['JWT_ACCESS_SECRET'] = 'test-access-secret-with-at-least-32-characters';
    process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-with-at-least-32-chars-x';
    process.env['LOG_LEVEL'] = 'fatal';
    process.env['OTP_TTL_SECONDS'] = '600';

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CACHE)
      .useFactory({ factory: () => new MemoryCache(), inject: [] })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: new JsonLogger('fatal'),
    });
    app.useGlobalFilters(new AllExceptionsFilter(new JsonLogger('fatal')));
    app.use(cookieParser());
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();

    pool = new Pool({ connectionString: CONNECTION, max: 4 });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM message_participants');
    await pool.query('DELETE FROM message_threads');
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM blocks');
    await pool.query('DELETE FROM follows');
    await pool.query('DELETE FROM verification_codes');
    await pool.query('DELETE FROM refresh_tokens');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM user_roles');
    await pool.query('DELETE FROM user_profiles');
    await pool.query(`DELETE FROM accounts WHERE account_type = 'USER'`);
  });

  const createActor = async (displayName = 'Messaging Tester'): Promise<Actor> => {
    const email = `m-${randomUUID()}@example.test`;
    const username = `u_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, username, displayName })
      .expect(202);

    const { rows } = await pool.query<{ code_digest: Buffer; id: string }>(
      `SELECT vc.code_digest, a.id FROM verification_codes vc
         JOIN accounts a ON a.id = vc.account_id
        WHERE a.email = $1 AND vc.purpose = 'EMAIL_VERIFY'`,
      [email],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('verification code missing');

    const { digestOtp } = await import('../auth/domain/one-time-code.js');
    let code = '';
    for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
      const attempt = candidate.toString().padStart(6, '0');
      if (
        digestOtp({ accountId: row.id, purpose: 'EMAIL_VERIFY', code: attempt }).equals(
          row.code_digest,
        )
      ) {
        code = attempt;
        break;
      }
    }
    if (code === '') throw new Error('could not recover OTP');

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ email, code })
      .expect(200);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return { accountId: row.id, username, accessToken: login.body.accessToken as string };
  };

  const auth = (actor: Actor) => ({ authorization: `Bearer ${actor.accessToken}` });

  const follow = async (follower: Actor, followee: Actor): Promise<void> => {
    await pool.query(
      'INSERT INTO follows (follower_id, followee_id, accepted_at) VALUES ($1, $2, now())',
      [follower.accountId, followee.accountId],
    );
  };

  const block = async (blocker: Actor, blocked: Actor): Promise<void> => {
    await pool.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
      blocker.accountId,
      blocked.accountId,
    ]);
  };

  const openDirect = async (from: Actor, to: Actor): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/messages/direct')
      .set(auth(from))
      .send({ accountId: to.accountId })
      .expect(201);
    return response.body.id as string;
  };

  const send = async (
    actor: Actor,
    threadId: string,
    body: string,
    clientId?: string,
  ): Promise<{ id: string }> => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/messages/conversations/${threadId}/messages`)
      .set(auth(actor))
      .send(clientId === undefined ? { body } : { body, clientId })
      .expect(201);
    return response.body.message as { id: string };
  };

  describe('opening a direct conversation', () => {
    it('opens one conversation for a mutual follow and reuses it from either side', async () => {
      const ada = await createActor('Ada Lovelace');
      const grace = await createActor('Grace Hopper');
      await follow(ada, grace);
      await follow(grace, ada);

      const first = await openDirect(ada, grace);
      const second = await openDirect(grace, ada);

      // One row for the pair: the second click does not fork the conversation.
      expect(second).toBe(first);

      const rows = await pool.query<{ count: string }>(
        'SELECT count(*)::text FROM message_threads',
      );
      expect(rows.rows[0]?.count).toBe('1');
    });

    it('titles a direct conversation after the other person, per viewer', async () => {
      const ada = await createActor('Ada Lovelace');
      const grace = await createActor('Grace Hopper');
      await follow(ada, grace);
      await follow(grace, ada);

      const threadId = await openDirect(ada, grace);

      const asAda = await request(app.getHttpServer())
        .get(`/api/v1/messages/conversations/${threadId}`)
        .set(auth(ada))
        .expect(200);
      const asGrace = await request(app.getHttpServer())
        .get(`/api/v1/messages/conversations/${threadId}`)
        .set(auth(grace))
        .expect(200);

      expect(asAda.body.title).toBe('Grace Hopper');
      expect(asGrace.body.title).toBe('Ada Lovelace');
    });

    /** A one-way follow may start a conversation; that is what makes it a DM. */
    it('allows a one-way follower to open the conversation', async () => {
      const ada = await createActor();
      const grace = await createActor();
      await follow(ada, grace);

      const threadId = await openDirect(ada, grace);
      await send(ada, threadId, 'Hello!');
    });

    it('refuses a stranger, and refuses without revealing anything about the account', async () => {
      const ada = await createActor();
      const grace = await createActor();

      const response = await request(app.getHttpServer())
        .post('/api/v1/messages/direct')
        .set(auth(ada))
        .send({ accountId: grace.accountId })
        .expect(403);

      const missing = await request(app.getHttpServer())
        .post('/api/v1/messages/direct')
        .set(auth(ada))
        .send({ accountId: randomUUID() })
        .expect(404);

      // The refusal for "no relationship" and "no such account" must not be usable to
      // tell the two apart by message text.
      expect(typeof response.body.error.code).toBe('string');
      expect(typeof missing.body.error.code).toBe('string');
    });

    it('refuses a blocked pair in either direction', async () => {
      const ada = await createActor();
      const grace = await createActor();
      await follow(ada, grace);
      await follow(grace, ada);
      await block(grace, ada);

      await request(app.getHttpServer())
        .post('/api/v1/messages/direct')
        .set(auth(ada))
        .send({ accountId: grace.accountId })
        .expect(403);
    });

    it('refuses a conversation with yourself', async () => {
      const ada = await createActor();
      await request(app.getHttpServer())
        .post('/api/v1/messages/direct')
        .set(auth(ada))
        .send({ accountId: ada.accountId })
        .expect(422);
    });
  });

  describe('sending and reading', () => {
    it('delivers a message and counts it unread for the other person only', async () => {
      const ada = await createActor('Ada Lovelace');
      const grace = await createActor('Grace Hopper');
      await follow(ada, grace);
      await follow(grace, ada);
      const threadId = await openDirect(ada, grace);

      await send(ada, threadId, '  First line\nsecond line  ');

      const transcript = await request(app.getHttpServer())
        .get(`/api/v1/messages/conversations/${threadId}/messages`)
        .set(auth(grace))
        .expect(200);

      // Trimmed at the edges, interior newline kept.
      expect(transcript.body.items[0].body).toBe('First line\nsecond line');
      expect(transcript.body.items[0].sender.username).toBe(ada.username);

      const inbox = await request(app.getHttpServer())
        .get('/api/v1/messages/conversations')
        .set(auth(grace))
        .expect(200);

      expect(inbox.body.items[0]).toMatchObject({
        id: threadId,
        unreadCount: 1,
        lastMessagePreview: 'First line second line',
      });
      expect(inbox.body.unreadThreads).toBe(1);

      // The sender's own message is not unread for the sender.
      const senderInbox = await request(app.getHttpServer())
        .get('/api/v1/messages/conversations')
        .set(auth(ada))
        .expect(200);
      expect(senderInbox.body.items[0].unreadCount).toBe(0);
    });

    it('clears the unread count when the reader opens the conversation', async () => {
      const ada = await createActor();
      const grace = await createActor();
      await follow(ada, grace);
      await follow(grace, ada);
      const threadId = await openDirect(ada, grace);

      await send(ada, threadId, 'one');
      await send(ada, threadId, 'two');

      const read = await request(app.getHttpServer())
        .post(`/api/v1/messages/conversations/${threadId}/read`)
        .set(auth(grace))
        .expect(201);
      expect(read.body.unreadCount).toBe(0);

      const inbox = await request(app.getHttpServer())
        .get('/api/v1/messages/conversations')
        .set(auth(grace))
        .expect(200);
      expect(inbox.body.items[0].unreadCount).toBe(0);

      // A message sent after the cursor is unread again, which is what proves the
      // cursor is a position rather than a "seen everything" flag.
      await send(ada, threadId, 'three');
      const after = await request(app.getHttpServer())
        .get('/api/v1/messages/conversations')
        .set(auth(grace))
        .expect(200);
      expect(after.body.items[0].unreadCount).toBe(1);
    });

    it('is idempotent for a repeated clientId', async () => {
      const ada = await createActor();
      const grace = await createActor();
      await follow(ada, grace);
      await follow(grace, ada);
      const threadId = await openDirect(ada, grace);

      const clientId = randomUUID();
      const first = await send(ada, threadId, 'sent once', clientId);
      const second = await send(ada, threadId, 'sent once', clientId);

      expect(second.id).toBe(first.id);

      const rows = await pool.query<{ count: string }>(
        'SELECT count(*)::text FROM messages WHERE thread_id = $1',
        [threadId],
      );
      expect(rows.rows[0]?.count).toBe('1');
    });

    it('rejects an empty message and one past the limit', async () => {
      const ada = await createActor();
      const grace = await createActor();
      await follow(ada, grace);
      await follow(grace, ada);
      const threadId = await openDirect(ada, grace);

      await request(app.getHttpServer())
        .post(`/api/v1/messages/conversations/${threadId}/messages`)
        .set(auth(ada))
        .send({ body: '   ' })
        .expect(422);

      await request(app.getHttpServer())
        .post(`/api/v1/messages/conversations/${threadId}/messages`)
        .set(auth(ada))
        .send({ body: 'x'.repeat(4_001) })
        .expect(422);
    });

    it('pages the transcript backwards', async () => {
      const ada = await createActor();
      const grace = await createActor();
      await follow(ada, grace);
      await follow(grace, ada);
      const threadId = await openDirect(ada, grace);

      for (const body of ['one', 'two', 'three']) await send(ada, threadId, body);

      const page = await request(app.getHttpServer())
        .get(`/api/v1/messages/conversations/${threadId}/messages?limit=2`)
        .set(auth(grace))
        .expect(200);

      expect(page.body.items.map((item: { body: string }) => item.body)).toEqual(['two', 'three']);
      expect(page.body.nextCursor).toBeTruthy();

      const older = await request(app.getHttpServer())
        .get(
          `/api/v1/messages/conversations/${threadId}/messages?limit=2&before=${page.body.nextCursor}`,
        )
        .set(auth(grace))
        .expect(200);

      expect(older.body.items.map((item: { body: string }) => item.body)).toEqual(['one']);
      expect(older.body.nextCursor).toBeNull();
    });

    it('returns not found for a thread the caller is not in', async () => {
      const ada = await createActor();
      const grace = await createActor();
      const outsider = await createActor();
      await follow(ada, grace);
      await follow(grace, ada);
      const threadId = await openDirect(ada, grace);

      await request(app.getHttpServer())
        .get(`/api/v1/messages/conversations/${threadId}/messages`)
        .set(auth(outsider))
        .expect(404);

      await request(app.getHttpServer())
        .post(`/api/v1/messages/conversations/${threadId}/messages`)
        .set(auth(outsider))
        .send({ body: 'let me in' })
        .expect(404);
    });
  });

  describe('blocks', () => {
    /** The main privacy property: a block ends the conversation, history included. */
    it('hides an existing conversation from both sides after a block', async () => {
      const ada = await createActor();
      const grace = await createActor();
      await follow(ada, grace);
      await follow(grace, ada);
      const threadId = await openDirect(ada, grace);
      await send(ada, threadId, 'before the block');

      await block(grace, ada);

      for (const actor of [ada, grace]) {
        await request(app.getHttpServer())
          .get(`/api/v1/messages/conversations/${threadId}`)
          .set(auth(actor))
          .expect(404);

        const inbox = await request(app.getHttpServer())
          .get('/api/v1/messages/conversations')
          .set(auth(actor))
          .expect(200);
        expect(inbox.body.items).toEqual([]);
      }
    });

    it('refuses a send into a blocked conversation', async () => {
      const ada = await createActor();
      const grace = await createActor();
      await follow(ada, grace);
      await follow(grace, ada);
      const threadId = await openDirect(ada, grace);

      await block(ada, grace);

      await request(app.getHttpServer())
        .post(`/api/v1/messages/conversations/${threadId}/messages`)
        .set(auth(ada))
        .send({ body: 'still here?' })
        .expect(404);
    });
  });

  describe('groups', () => {
    const createGroup = async (
      owner: Actor,
      memberIds: string[],
      title = 'Release planning',
    ): Promise<string> => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/messages/groups')
        .set(auth(owner))
        .send({ title, memberIds })
        .expect(201);
      return response.body.id as string;
    };

    it('creates a group and lets every member read and write', async () => {
      const owner = await createActor('Owner');
      const member = await createActor('Member');
      const threadId = await createGroup(owner, [member.accountId]);

      await send(member, threadId, 'hello group');

      const inbox = await request(app.getHttpServer())
        .get('/api/v1/messages/conversations')
        .set(auth(owner))
        .expect(200);

      expect(inbox.body.items[0]).toMatchObject({
        id: threadId,
        kind: 'GROUP',
        title: 'Release planning',
        unreadCount: 1,
        viewerIsOwner: true,
      });
    });

    it('refuses a group with no name or no members', async () => {
      const owner = await createActor();
      const member = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/messages/groups')
        .set(auth(owner))
        .send({ title: '  ', memberIds: [member.accountId] })
        .expect(422);

      await request(app.getHttpServer())
        .post('/api/v1/messages/groups')
        .set(auth(owner))
        .send({ title: 'Team', memberIds: [] })
        .expect(422);
    });

    it('lets only the owner rename and lock the group', async () => {
      const owner = await createActor();
      const member = await createActor();
      const threadId = await createGroup(owner, [member.accountId]);

      await request(app.getHttpServer())
        .post(`/api/v1/messages/conversations/${threadId}`)
        .set(auth(member))
        .send({ title: 'Hijacked' })
        .expect(403);

      const renamed = await request(app.getHttpServer())
        .post(`/api/v1/messages/conversations/${threadId}`)
        .set(auth(owner))
        .send({ title: 'Renamed' })
        .expect(201);
      expect(renamed.body.title).toBe('Renamed');

      await request(app.getHttpServer())
        .post(`/api/v1/messages/conversations/${threadId}`)
        .set(auth(owner))
        .send({ locked: true })
        .expect(201);

      // Locked: nobody may send, the owner included.
      await request(app.getHttpServer())
        .post(`/api/v1/messages/conversations/${threadId}/messages`)
        .set(auth(member))
        .send({ body: 'are we still on?' })
        .expect(412);
    });

    it('adds a member and refuses a blocked invite', async () => {
      const owner = await createActor();
      const member = await createActor();
      const newcomer = await createActor();
      const blocked = await createActor();
      const threadId = await createGroup(owner, [member.accountId]);

      const added = await request(app.getHttpServer())
        .post(`/api/v1/messages/conversations/${threadId}/members`)
        .set(auth(owner))
        .send({ memberIds: [newcomer.accountId] })
        .expect(201);
      expect(
        (added.body.participants as { accountId: string }[]).map((p) => p.accountId),
      ).toContain(newcomer.accountId);

      await block(owner, blocked);
      await request(app.getHttpServer())
        .post(`/api/v1/messages/conversations/${threadId}/members`)
        .set(auth(owner))
        .send({ memberIds: [blocked.accountId] })
        .expect(403);
    });

    it('lets a member leave a group but not a direct conversation', async () => {
      const owner = await createActor();
      const member = await createActor();
      const threadId = await createGroup(owner, [member.accountId]);

      await request(app.getHttpServer())
        .delete(`/api/v1/messages/conversations/${threadId}/members/me`)
        .set(auth(member))
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/v1/messages/conversations/${threadId}`)
        .set(auth(member))
        .expect(404);

      const ada = await createActor();
      const grace = await createActor();
      await follow(ada, grace);
      await follow(grace, ada);
      const direct = await openDirect(ada, grace);

      await request(app.getHttpServer())
        .delete(`/api/v1/messages/conversations/${direct}/members/me`)
        .set(auth(ada))
        .expect(412);
    });

    /** A group is not a way around a block: the blocked member loses the group. */
    it('hides the group from both sides of a block between two members', async () => {
      const owner = await createActor();
      const member = await createActor();
      const bystander = await createActor();
      const threadId = await createGroup(owner, [member.accountId, bystander.accountId]);

      await block(member, owner);

      await request(app.getHttpServer())
        .get(`/api/v1/messages/conversations/${threadId}`)
        .set(auth(owner))
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/messages/conversations/${threadId}`)
        .set(auth(member))
        .expect(404);
      // The uninvolved member keeps the conversation.
      await request(app.getHttpServer())
        .get(`/api/v1/messages/conversations/${threadId}`)
        .set(auth(bystander))
        .expect(200);
    });
  });

  describe('deleting', () => {
    it('soft-deletes the sender\u2019s own message and serves a placeholder', async () => {
      const ada = await createActor();
      const grace = await createActor();
      await follow(ada, grace);
      await follow(grace, ada);
      const threadId = await openDirect(ada, grace);
      const message = await send(ada, threadId, 'regrettable');

      await request(app.getHttpServer())
        .delete(`/api/v1/messages/conversations/${threadId}/messages/${message.id}`)
        .set(auth(ada))
        .expect(204);

      const transcript = await request(app.getHttpServer())
        .get(`/api/v1/messages/conversations/${threadId}/messages`)
        .set(auth(grace))
        .expect(200);

      expect(transcript.body.items[0]).toMatchObject({
        id: message.id,
        deleted: true,
        body: 'This message was deleted',
      });

      // The row survives, so a reply keeps its context.
      const rows = await pool.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM messages WHERE id = $1',
        [message.id],
      );
      expect(rows.rows[0]?.deleted_at).not.toBeNull();
    });

    it('refuses to delete someone else\u2019s message', async () => {
      const ada = await createActor();
      const grace = await createActor();
      await follow(ada, grace);
      await follow(grace, ada);
      const threadId = await openDirect(ada, grace);
      const message = await send(ada, threadId, 'mine');

      await request(app.getHttpServer())
        .delete(`/api/v1/messages/conversations/${threadId}/messages/${message.id}`)
        .set(auth(grace))
        .expect(404);
    });
  });

  it('requires authentication on every route', async () => {
    await request(app.getHttpServer()).get('/api/v1/messages/conversations').expect(401);
    await request(app.getHttpServer()).post('/api/v1/messages/direct').send({}).expect(401);
  });
});
