/**
 * Notification end-to-end tests.
 *
 * These assert the properties only a real database can demonstrate:
 *
 *   * collapsing is atomic under the unique index, including the actor count and
 *     the bounded actor list;
 *   * a block silences a notification that the event would otherwise produce;
 *   * the inbox query applies the recipient filter, so one account can never page
 *     another's notifications.
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

describeWithDb('notifications (e2e)', () => {
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
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM post_likes');
    await pool.query('DELETE FROM post_audience');
    await pool.query('DELETE FROM posts');
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
    const email = `n-${randomUUID()}@example.test`;
    const username = `u_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, username, displayName: 'Notify Tester' })
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

  const publish = async (actor: Actor, body: string): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/posts')
      .set(auth(actor))
      .send({ body, visibility: 'PUBLIC' })
      .expect(201);
    return response.body.id as string;
  };

  const like = async (actor: Actor, postId: string): Promise<void> => {
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${postId}/like`)
      .set(auth(actor))
      .expect(200);
  };

  const follow = async (follower: Actor, target: Actor): Promise<void> => {
    await request(app.getHttpServer())
      .post('/api/v1/social/follow')
      .set(auth(follower))
      .send({ accountId: target.accountId })
      .expect(200);
  };

  const inbox = async (actor: Actor): Promise<{ items: Record<string, unknown>[] }> => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set(auth(actor))
      .expect(200);
    return response.body as { items: Record<string, unknown>[] };
  };

  describe('likes', () => {
    it('tells a post author that someone liked it', async () => {
      const author = await createActor();
      const reader = await createActor();
      const postId = await publish(author, 'a post worth liking');

      await like(reader, postId);

      const { items } = await inbox(author);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: 'LIKE',
        subjectType: 'post',
        subjectId: postId,
        actorCount: 1,
        preview: 'a post worth liking',
        read: false,
      });
      expect((items[0]?.['actors'] as { username: string }[])[0]?.username).toBe(reader.username);
    });

    it('collapses several likes on one post into a single row', async () => {
      const author = await createActor();
      const first = await createActor();
      const second = await createActor();
      const postId = await publish(author, 'viral');

      await like(first, postId);
      await like(second, postId);

      const { items } = await inbox(author);
      // One row, two people — that is the whole point of collapsing at write time.
      expect(items).toHaveLength(1);
      expect(items[0]?.['actorCount']).toBe(2);
      expect((items[0]?.['actors'] as unknown[]).length).toBe(2);

      const { rows } = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notifications WHERE recipient_id = $1',
        [author.accountId],
      );
      expect(rows[0]?.n).toBe('1');
    });

    it('does not inflate the count when the same actor likes, unlikes and likes again', async () => {
      const author = await createActor();
      const reader = await createActor();
      const postId = await publish(author, 'again');

      await like(reader, postId);
      await request(app.getHttpServer())
        .delete(`/api/v1/posts/${postId}/like`)
        .set(auth(reader))
        .expect(200);
      await like(reader, postId);

      const { items } = await inbox(author);
      // One person is one person, however many times they pressed the button.
      expect(items[0]?.['actorCount']).toBe(1);
      expect((items[0]?.['actors'] as unknown[]).length).toBe(1);
    });

    it('bounds the actor list at five while counting them all', async () => {
      const author = await createActor();
      const postId = await publish(author, 'very viral');

      for (let index = 0; index < 6; index += 1) {
        await like(await createActor(), postId);
      }

      const { items } = await inbox(author);
      expect(items[0]?.['actorCount']).toBe(6);
      expect((items[0]?.['actors'] as unknown[]).length).toBe(5);
    });

    it('does not notify an author about their own like', async () => {
      const author = await createActor();
      const postId = await publish(author, 'self love');
      await like(author, postId);

      expect((await inbox(author)).items).toHaveLength(0);
    });

    it('does not announce a like from a blocked account', async () => {
      const author = await createActor();
      const reader = await createActor();
      const postId = await publish(author, 'blocked soon');

      await request(app.getHttpServer())
        .post('/api/v1/social/block')
        .set(auth(author))
        .send({ accountId: reader.accountId })
        .expect(204);

      // The like itself is refused (the post is invisible), which is the stronger
      // guarantee; the assertion is that no row was written either way.
      await request(app.getHttpServer()).post(`/api/v1/posts/${postId}/like`).set(auth(reader));

      expect((await inbox(author)).items).toHaveLength(0);
    });
  });

  describe('replies and mentions', () => {
    it('notifies the parent author and a mentioned account', async () => {
      const author = await createActor();
      const mentioned = await createActor();
      const replier = await createActor();
      const parentId = await publish(author, 'a question');

      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(auth(replier))
        .send({
          body: `an answer for @${mentioned.username}`,
          replyTo: parentId,
        })
        .expect(201);

      const parentInbox = await inbox(author);
      expect(parentInbox.items.map((item) => item['kind'])).toContain('REPLY');

      const mentionInbox = await inbox(mentioned);
      expect(mentionInbox.items.map((item) => item['kind'])).toContain('MENTION');
    });

    it('does not notify a reply author about their own mention', async () => {
      const author = await createActor();
      const replier = await createActor();
      const parentId = await publish(author, 'question');

      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(auth(replier))
        .send({ body: `note to @${replier.username}`, replyTo: parentId })
        .expect(201);

      const kinds = (await inbox(replier)).items.map((item) => item['kind']);
      expect(kinds).not.toContain('MENTION');
    });
  });

  describe('the inbox', () => {
    it('reports an unread summary and marks rows read', async () => {
      const author = await createActor();
      const reader = await createActor();
      const postId = await publish(author, 'read me');
      await like(reader, postId);

      const summary = await request(app.getHttpServer())
        .get('/api/v1/notifications/summary')
        .set(auth(author))
        .expect(200);
      expect(summary.body).toMatchObject({ unreadCount: 1, badge: '1' });

      const { items } = await inbox(author);
      const id = items[0]?.['id'] as string;

      const read = await request(app.getHttpServer())
        .post(`/api/v1/notifications/${id}/read`)
        .set(auth(author))
        .expect(200);
      expect(read.body.unreadCount).toBe(0);

      const after = await request(app.getHttpServer())
        .get('/api/v1/notifications/summary')
        .set(auth(author))
        .expect(200);
      expect(after.body.unreadCount).toBe(0);
    });

    it('cannot read another account notification', async () => {
      const author = await createActor();
      const reader = await createActor();
      const postId = await publish(author, 'mine');
      await like(reader, postId);

      const id = (await inbox(author)).items[0]?.['id'] as string;

      // The row exists; it is simply not the caller's. Same answer as a row that
      // does not exist, so notification ids never confirm activity to strangers.
      await request(app.getHttpServer())
        .post(`/api/v1/notifications/${id}/read`)
        .set(auth(reader))
        .expect(404);
    });

    it('filters to unread only and marks everything read', async () => {
      const author = await createActor();
      const first = await createActor();
      const second = await createActor();
      await like(first, await publish(author, 'one'));
      await like(second, await publish(author, 'two'));

      const unread = await request(app.getHttpServer())
        .get('/api/v1/notifications?unreadOnly=true')
        .set(auth(author))
        .expect(200);
      expect((unread.body.items as unknown[]).length).toBe(2);

      const cleared = await request(app.getHttpServer())
        .post('/api/v1/notifications/read-all')
        .set(auth(author))
        .expect(200);
      expect(cleared.body.unreadCount).toBe(0);

      const empty = await request(app.getHttpServer())
        .get('/api/v1/notifications?unreadOnly=true')
        .set(auth(author))
        .expect(200);
      expect((empty.body.items as unknown[]).length).toBe(0);
      // The read rows are still in the inbox; only the filter excludes them.
      expect((await inbox(author)).items.length).toBe(2);
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/notifications').expect(401);
      await request(app.getHttpServer()).get('/api/v1/notifications/stream').expect(401);
    });

    it('pages without repeating a row', async () => {
      const author = await createActor();
      const postId = await publish(author, 'many');
      for (let index = 0; index < 3; index += 1) {
        await like(await createActor(), postId);
      }
      // Three separate posts, so three separate rows.
      await like(await createActor(), await publish(author, 'second'));
      await like(await createActor(), await publish(author, 'third'));

      const firstPage = await request(app.getHttpServer())
        .get('/api/v1/notifications?limit=2')
        .set(auth(author))
        .expect(200);
      const firstIds = (firstPage.body.items as { id: string }[]).map((item) => item.id);
      expect(firstIds).toHaveLength(2);
      expect(firstPage.body.nextCursor).toBe(firstIds[1]);

      const secondPage = await request(app.getHttpServer())
        .get(`/api/v1/notifications?limit=2&cursor=${String(firstPage.body.nextCursor)}`)
        .set(auth(author))
        .expect(200);
      const secondIds = (secondPage.body.items as { id: string }[]).map((item) => item.id);

      expect(secondIds).toHaveLength(1);
      expect(secondIds.filter((id) => firstIds.includes(id))).toHaveLength(0);
      expect(secondPage.body.nextCursor).toBeNull();
    });
  });

  describe('the live stream', () => {
    /**
     * The stream is exercised as a real socket rather than by calling the controller:
     * the headers, the ready frame and the heartbeat are the contract, and none of
     * them exist in a unit test.
     */
    it('opens an event stream and delivers a notification frame', async () => {
      const author = await createActor();
      const reader = await createActor();
      const postId = await publish(author, 'streamed');

      const server = app.getHttpServer() as import('node:http').Server;
      await new Promise<void>((resolve) => {
        if (server.listening) resolve();
        else server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address() as import('node:net').AddressInfo;

      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const req = (require('node:http') as typeof import('node:http')).get(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/api/v1/notifications/stream',
            headers: { authorization: `Bearer ${author.accessToken}` },
          },
          resolve,
        );
        req.on('error', reject);
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');

      const chunks: string[] = [];
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => chunks.push(chunk));

      // Wait for the ready frame before producing the event, so the assertion does
      // not depend on the subscription being registered within a fixed sleep.
      const waitFor = async (needle: string): Promise<void> => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (chunks.join('').includes(needle)) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`timed out waiting for ${needle}: ${chunks.join('')}`);
      };

      await waitFor('event: ready');

      await like(reader, postId);
      await waitFor('"type":"notification"');

      // The unread frame is published *after* the notification row, and the store
      // call it needs is a second round trip — so wait for it explicitly rather
      // than assuming both frames land in the same tick.
      await waitFor('"type":"unread"');

      const text = chunks.join('');
      expect(text).toContain('"type":"notification"');
      expect(text).toContain('"kind":"LIKE"');
      expect(text).toContain('"unreadCount":1');

      // Closing the client must release the subscription; the assertion is that the
      // process stays healthy and the next request is served normally.
      response.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await follow(reader, author);
      server.close();
    });
  });
});
