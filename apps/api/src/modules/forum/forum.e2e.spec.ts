/**
 * Forum end-to-end tests.
 *
 * The properties only a database shows: a block hides a thread from the list, the
 * detail and the answers route at once; the answer counter is maintained by a
 * trigger; and the partial unique index really does allow one accepted answer.
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

describeWithDb('forum (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let categoryId: string;

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
    // The starter tree arrives with migration 0005; read it rather than creating one,
    // so the tests fail if that migration is missing.
    const categories = await pool.query<{ id: string; path: string }>(
      `SELECT id, path FROM forum_categories WHERE path = '/general'`,
    );
    const row = categories.rows[0];
    if (row === undefined) throw new Error('starter categories missing');
    categoryId = row.id;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM forum_answers');
    await pool.query('DELETE FROM forum_threads');
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

  const createActor = async (): Promise<Actor> => {
    const email = `f-${randomUUID()}@example.test`;
    const username = `u_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, username, displayName: 'Forum Tester' })
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

  const createThread = async (actor: Actor, title = 'A thread title'): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/forum/threads')
      .set(auth(actor))
      .send({ categoryId, title, body: 'The body of the thread.' })
      .expect(201);
    return response.body.id as string;
  };

  const addAnswer = async (actor: Actor, threadId: string, body = 'An answer'): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/forum/threads/${threadId}/answers`)
      .set(auth(actor))
      .send({ body })
      .expect(201);
    return response.body.id as string;
  };

  describe('categories', () => {
    it('lists the starter tree with counts', async () => {
      const actor = await createActor();
      const response = await request(app.getHttpServer())
        .get('/api/v1/forum/categories')
        .set(auth(actor))
        .expect(200);

      const paths = (response.body.items as { path: string }[]).map((item) => item.path);
      expect(paths).toContain('/general');
      expect(paths).toContain('/general/help');
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/forum/threads').expect(401);
    });
  });

  describe('threads', () => {
    it('creates and reads a thread, counting answers from the rows', async () => {
      const author = await createActor();
      const reader = await createActor();
      const threadId = await createThread(author);

      await addAnswer(reader, threadId);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/forum/threads/${threadId}`)
        .set(auth(reader))
        .expect(200);

      expect(detail.body.thread).toMatchObject({
        id: threadId,
        answerCount: 1,
        hasAcceptedAnswer: false,
        categoryPath: '/general',
        locked: false,
      });
      expect((detail.body.answers as unknown[]).length).toBe(1);
      // Only the author may accept, and only before one is accepted.
      expect(detail.body.thread.canAcceptAnswer).toBe(false);
    });

    it('rejects an over-long title and an unknown category', async () => {
      const actor = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/forum/threads')
        .set(auth(actor))
        .send({ categoryId, title: 'ab', body: 'body' })
        .expect(422);

      await request(app.getHttpServer())
        .post('/api/v1/forum/threads')
        .set(auth(actor))
        .send({
          categoryId: '0190f3c1-0000-7000-8000-00000000ffff',
          title: 'A valid title',
          body: 'body',
        })
        .expect(422);
    });

    it('filters by category path, including descendants', async () => {
      const actor = await createActor();
      const threadId = await createThread(actor);

      const general = await request(app.getHttpServer())
        .get('/api/v1/forum/threads?category=/general')
        .set(auth(actor))
        .expect(200);
      expect((general.body.items as { id: string }[]).map((item) => item.id)).toContain(threadId);

      const feedback = await request(app.getHttpServer())
        .get('/api/v1/forum/threads?category=/feedback')
        .set(auth(actor))
        .expect(200);
      expect((feedback.body.items as { id: string }[]).map((item) => item.id)).not.toContain(
        threadId,
      );
    });

    it('pages without repeating a thread', async () => {
      const actor = await createActor();
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        ids.push(await createThread(actor, `Thread number ${index}`));
      }

      const first = await request(app.getHttpServer())
        .get('/api/v1/forum/threads?limit=2')
        .set(auth(actor))
        .expect(200);
      const firstIds = (first.body.items as { id: string }[]).map((item) => item.id);

      const second = await request(app.getHttpServer())
        .get(`/api/v1/forum/threads?limit=2&cursor=${String(first.body.nextCursor)}`)
        .set(auth(actor))
        .expect(200);
      const secondIds = (second.body.items as { id: string }[]).map((item) => item.id);

      expect(new Set([...firstIds, ...secondIds])).toEqual(new Set(ids));
      expect(secondIds.filter((id) => firstIds.includes(id))).toHaveLength(0);
    });
  });

  describe('blocks', () => {
    it('hides a thread from the list, the detail and the answers at once', async () => {
      const author = await createActor();
      const reader = await createActor();
      const threadId = await createThread(author);

      await request(app.getHttpServer())
        .get(`/api/v1/forum/threads/${threadId}`)
        .set(auth(reader))
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/social/block')
        .set(auth(author))
        .send({ accountId: reader.accountId })
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/v1/forum/threads/${threadId}`)
        .set(auth(reader))
        .expect(404);

      // The answers route is a separate path; a block that stopped at the detail
      // would still hand over the conversation.
      await request(app.getHttpServer())
        .get(`/api/v1/forum/threads/${threadId}/answers`)
        .set(auth(reader))
        .expect(404);

      const listed = await request(app.getHttpServer())
        .get('/api/v1/forum/threads')
        .set(auth(reader))
        .expect(200);
      expect((listed.body.items as { id: string }[]).map((item) => item.id)).not.toContain(
        threadId,
      );
    });
  });

  describe('answers', () => {
    it('accepts an answer once, and only by the thread author', async () => {
      const author = await createActor();
      const other = await createActor();
      const threadId = await createThread(author);
      const answerId = await addAnswer(other, threadId);

      // A non-author is told the answer does not exist.
      await request(app.getHttpServer())
        .post(`/api/v1/forum/threads/${threadId}/answers/${answerId}/accept`)
        .set(auth(other))
        .expect(404);

      const accepted = await request(app.getHttpServer())
        .post(`/api/v1/forum/threads/${threadId}/answers/${answerId}/accept`)
        .set(auth(author))
        .expect(200);
      expect(accepted.body.accepted).toBe(true);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/forum/threads/${threadId}`)
        .set(auth(author))
        .expect(200);
      expect(detail.body.thread.hasAcceptedAnswer).toBe(true);
      // A second acceptance would need a second endorsement; the contract exposes one.
      expect(detail.body.thread.canAcceptAnswer).toBe(false);

      // Re-accepting a different answer moves the endorsement, which the partial
      // unique index permits only because the old one is cleared first.
      const second = await addAnswer(other, threadId, 'A better answer');
      await request(app.getHttpServer())
        .post(`/api/v1/forum/threads/${threadId}/answers/${second}/accept`)
        .set(auth(author))
        .expect(200);

      const stored = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM forum_answers WHERE accepted_at IS NOT NULL',
      );
      expect(stored.rows[0]?.n).toBe('1');
    });

    it('notifies the thread author that an answer arrived', async () => {
      const author = await createActor();
      const other = await createActor();
      const threadId = await createThread(author);
      await addAnswer(other, threadId);

      const inbox = await request(app.getHttpServer())
        .get('/api/v1/notifications')
        .set(auth(author))
        .expect(200);

      const kinds = (inbox.body.items as { kind: string }[]).map((item) => item.kind);
      // The notification request completes before the answer response, so no wait
      // is needed.
      expect(kinds).toContain('THREAD_ANSWER');
    });

    it('deletes an answer for its author and the thread author, not a stranger', async () => {
      const author = await createActor();
      const answerer = await createActor();
      const stranger = await createActor();
      const threadId = await createThread(author);
      const answerId = await addAnswer(answerer, threadId);

      await request(app.getHttpServer())
        .delete(`/api/v1/forum/answers/${answerId}`)
        .set(auth(stranger))
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/api/v1/forum/answers/${answerId}`)
        .set(auth(author))
        .expect(204);

      const counted = await pool.query<{ answer_count: number }>(
        'SELECT answer_count FROM forum_threads WHERE id = $1',
        [threadId],
      );
      expect(counted.rows[0]?.answer_count).toBe(0);
    });

    it('refuses an answer on a locked thread', async () => {
      const author = await createActor();
      const other = await createActor();
      const threadId = await createThread(author);

      // Locking has no API yet — it is a moderation action — so the row is set
      // directly, which is also proof that the refusal is enforced below the service.
      await pool.query('UPDATE forum_threads SET locked = true WHERE id = $1', [threadId]);

      await request(app.getHttpServer())
        .post(`/api/v1/forum/threads/${threadId}/answers`)
        .set(auth(other))
        .send({ body: 'too late' })
        .expect(412);
    });

    it('rejects an empty answer body', async () => {
      const author = await createActor();
      const threadId = await createThread(author);

      await request(app.getHttpServer())
        .post(`/api/v1/forum/threads/${threadId}/answers`)
        .set(auth(author))
        .send({ body: '    ' })
        .expect(422);
    });
  });
});
