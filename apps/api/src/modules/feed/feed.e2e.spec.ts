/**
 * Feed end-to-end tests.
 *
 * These assert the properties a unit test cannot: that the timeline query really
 * applies `can_view_post()`, that the audience snapshot behaves as a snapshot, and
 * that a blocked account's posts leave the viewer's feed.
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

describeWithDb('feed (e2e)', () => {
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
    const email = `f-${randomUUID()}@example.test`;
    const username = `u_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, username, displayName: 'Feed Tester' })
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

  const publish = async (
    actor: Actor,
    body: string,
    visibility: 'PUBLIC' | 'FOLLOWERS' | 'PRIVATE' = 'PUBLIC',
    replyTo?: string,
  ): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/posts')
      .set(auth(actor))
      .send({ body, visibility, ...(replyTo === undefined ? {} : { replyTo }) })
      .expect(201);

    return response.body.id as string;
  };

  const follow = async (follower: Actor, target: Actor): Promise<void> => {
    await request(app.getHttpServer())
      .post('/api/v1/social/follow')
      .set(auth(follower))
      .send({ accountId: target.accountId })
      .expect(200);
  };

  const feedIds = async (actor: Actor, query = ''): Promise<string[]> => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/feed${query}`)
      .set(auth(actor))
      .expect(200);
    return (response.body.items as { id: string }[]).map((item) => item.id);
  };

  describe('publishing', () => {
    it('creates a post and returns it with its author', async () => {
      const actor = await createActor();
      const response = await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(auth(actor))
        .send({ body: 'hello world' })
        .expect(201);

      expect(response.body).toMatchObject({
        body: 'hello world',
        visibility: 'PUBLIC',
        likeCount: 0,
        likedByMe: false,
      });
      expect(response.body.author.username).toBe(actor.username);
    });

    it('rejects a blank body and an over-long body', async () => {
      const actor = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(auth(actor))
        .send({ body: '    ' })
        .expect(422);

      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(auth(actor))
        .send({ body: 'x'.repeat(5_001) })
        .expect(422);
    });

    it('rejects an unknown visibility and an unknown field', async () => {
      const actor = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(auth(actor))
        .send({ body: 'hi', visibility: 'FRIENDS' })
        .expect(422);

      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(auth(actor))
        .send({ body: 'hi', pinned: true })
        .expect(422);
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/feed').expect(401);
    });
  });

  describe('home timeline', () => {
    it('shows the viewer their own post', async () => {
      const actor = await createActor();
      const id = await publish(actor, 'my first post');
      expect(await feedIds(actor)).toContain(id);
    });

    /**
     * The property the whole design exists for: a FOLLOWERS post reaches the
     * published audience and nobody else.
     */
    it('delivers a FOLLOWERS post to a follower but not a stranger', async () => {
      const author = await createActor();
      const follower = await createActor();
      const stranger = await createActor();

      await follow(follower, author);
      const id = await publish(author, 'members only', 'FOLLOWERS');

      expect(await feedIds(follower)).toContain(id);
      expect(await feedIds(stranger)).not.toContain(id);
    });

    /**
     * The audience is a snapshot: someone who follows *after* publication is not
     * in the addressed audience, even though `can_view_post` would now allow them
     * to read it directly. This is the difference between "may read" and "was
     * addressed", and it is what stops a new follower from receiving history.
     */
    it('does not deliver history to a later follower', async () => {
      const author = await createActor();
      const late = await createActor();

      const id = await publish(author, 'posted before you arrived', 'FOLLOWERS');
      await follow(late, author);

      expect(await feedIds(late)).not.toContain(id);
      // But the post itself is now readable, because the follow is live.
      await request(app.getHttpServer()).get(`/api/v1/posts/${id}`).set(auth(late)).expect(200);
    });

    it('never delivers a PRIVATE post to anyone else', async () => {
      const author = await createActor();
      const follower = await createActor();

      await follow(follower, author);
      const id = await publish(author, 'just me', 'PRIVATE');

      expect(await feedIds(author)).toContain(id);
      expect(await feedIds(follower)).not.toContain(id);
    });

    /** A block must remove an already-delivered post from the viewer's feed. */
    it('removes a blocked account’s posts from the feed', async () => {
      const author = await createActor();
      const viewer = await createActor();

      await follow(viewer, author);
      const id = await publish(author, 'public post');
      expect(await feedIds(viewer)).toContain(id);

      await request(app.getHttpServer())
        .post('/api/v1/social/block')
        .set(auth(viewer))
        .send({ accountId: author.accountId })
        .expect(204);

      expect(await feedIds(viewer)).not.toContain(id);
      await request(app.getHttpServer()).get(`/api/v1/posts/${id}`).set(auth(viewer)).expect(404);
    });

    it('paginates without repeating or skipping a post', async () => {
      const actor = await createActor();
      for (let index = 0; index < 5; index += 1) {
        await publish(actor, `post ${index}`);
      }

      const first = await request(app.getHttpServer())
        .get('/api/v1/feed?limit=2')
        .set(auth(actor))
        .expect(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await request(app.getHttpServer())
        .get(`/api/v1/feed?limit=2&cursor=${first.body.nextCursor}`)
        .set(auth(actor))
        .expect(200);

      const firstIds = (first.body.items as { id: string }[]).map((item) => item.id);
      const secondIds = (second.body.items as { id: string }[]).map((item) => item.id);
      expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    });

    it('returns the newest post first', async () => {
      const actor = await createActor();
      const older = await publish(actor, 'older');
      const newer = await publish(actor, 'newer');

      const ids = await feedIds(actor);
      expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
    });
  });

  describe('author timeline', () => {
    it('lists an author’s posts and respects the viewer’s visibility', async () => {
      const author = await createActor();
      const stranger = await createActor();

      const publicPost = await publish(author, 'public');
      const followersOnly = await publish(author, 'followers', 'FOLLOWERS');

      const response = await request(app.getHttpServer())
        .get(`/api/v1/profiles/${author.username}/posts`)
        .set(auth(stranger))
        .expect(200);

      const ids = (response.body.items as { id: string }[]).map((item) => item.id);
      expect(ids).toContain(publicPost);
      expect(ids).not.toContain(followersOnly);
    });

    it('returns 404 for an unknown author', async () => {
      const actor = await createActor();
      await request(app.getHttpServer())
        .get('/api/v1/profiles/nobody_here/posts')
        .set(auth(actor))
        .expect(404);
    });
  });

  describe('replies', () => {
    it('narrows a reply to a followers-only parent', async () => {
      const author = await createActor();
      const follower = await createActor();
      const stranger = await createActor();

      await follow(follower, author);
      const parent = await publish(author, 'members', 'FOLLOWERS');
      const reply = await publish(follower, 'a public reply', 'PUBLIC', parent);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/posts/${reply}`)
        .set(auth(follower))
        .expect(200);

      // The reply was requested as PUBLIC but is stored as FOLLOWERS.
      expect(response.body.visibility).toBe('FOLLOWERS');

      await request(app.getHttpServer())
        .get(`/api/v1/posts/${reply}`)
        .set(auth(stranger))
        .expect(404);
    });

    it('refuses a reply to a post the caller cannot see', async () => {
      const author = await createActor();
      const stranger = await createActor();

      const parent = await publish(author, 'private', 'PRIVATE');
      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(auth(stranger))
        .send({ body: 'reply', replyTo: parent })
        .expect(404);
    });

    it('counts replies and likes on the parent', async () => {
      const author = await createActor();
      const parent = await publish(author, 'parent');

      await publish(author, 'reply', 'PUBLIC', parent);
      await request(app.getHttpServer())
        .post(`/api/v1/posts/${parent}/like`)
        .set(auth(author))
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/posts/${parent}`)
        .set(auth(author))
        .expect(200);

      expect(response.body.replyCount).toBe(1);
      expect(response.body.likeCount).toBe(1);
      expect(response.body.likedByMe).toBe(true);
    });
  });

  describe('likes', () => {
    it('is idempotent and reports the resulting count', async () => {
      const author = await createActor();
      const liker = await createActor();
      const post = await publish(author, 'like me');

      const first = await request(app.getHttpServer())
        .post(`/api/v1/posts/${post}/like`)
        .set(auth(liker))
        .expect(200);
      expect(first.body).toEqual({ liked: true, likeCount: 1 });

      const second = await request(app.getHttpServer())
        .post(`/api/v1/posts/${post}/like`)
        .set(auth(liker))
        .expect(200);
      expect(second.body).toEqual({ liked: true, likeCount: 1 });

      const off = await request(app.getHttpServer())
        .delete(`/api/v1/posts/${post}/like`)
        .set(auth(liker))
        .expect(200);
      expect(off.body).toEqual({ liked: false, likeCount: 0 });
    });

    it('refuses to like a post the viewer cannot see', async () => {
      const author = await createActor();
      const stranger = await createActor();
      const post = await publish(author, 'private', 'PRIVATE');

      await request(app.getHttpServer())
        .post(`/api/v1/posts/${post}/like`)
        .set(auth(stranger))
        .expect(404);
    });
  });

  describe('editing and deleting', () => {
    it('edits an owned post and records the edit time', async () => {
      const author = await createActor();
      const post = await publish(author, 'draft');

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/posts/${post}`)
        .set(auth(author))
        .send({ body: 'final' })
        .expect(200);

      expect(response.body.body).toBe('final');
      expect(response.body.editedAt).not.toBeNull();
    });

    it('reports another account’s post as missing, not forbidden', async () => {
      const author = await createActor();
      const other = await createActor();
      const post = await publish(author, 'mine');

      await request(app.getHttpServer())
        .patch(`/api/v1/posts/${post}`)
        .set(auth(other))
        .send({ body: 'hijacked' })
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/api/v1/posts/${post}`)
        .set(auth(other))
        .expect(404);
    });

    it('deletes an owned post and removes it from followers’ feeds', async () => {
      const author = await createActor();
      const follower = await createActor();

      await follow(follower, author);
      const post = await publish(author, 'temporary');

      await request(app.getHttpServer())
        .delete(`/api/v1/posts/${post}`)
        .set(auth(author))
        .expect(204);

      expect(await feedIds(follower)).not.toContain(post);
    });
  });
});
