/**
 * Blog end-to-end tests.
 *
 * The properties only a database and a real HTTP stack show: one article per URL, a draft
 * that no other account can read by id or by slug, a scheduled article that becomes
 * readable the moment it is due without anything flipping its status, a block that hides
 * an article from the reader while its author keeps their own copy, and a tag cloud that
 * counts only what a reader can reach.
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

describeWithDb('blog (e2e)', () => {
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
    await pool.query('DELETE FROM article_tags');
    await pool.query('DELETE FROM articles');
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

  const createActor = async (): Promise<Actor> => {
    const email = `b-${randomUUID()}@example.test`;
    const username = `u_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, username, displayName: 'Blog Tester' })
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

  const createArticle = async (
    actor: Actor,
    input: Partial<{ title: string; body: string; slug: string; tags: string[] }> = {},
  ): Promise<{ id: string; slug: string }> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/blog/articles')
      .set(auth(actor))
      .send({
        title: input.title ?? 'A perfectly reasonable title',
        body: input.body ?? 'The body of the article.',
        ...(input.slug === undefined ? {} : { slug: input.slug }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
      })
      .expect(201);

    return { id: response.body.id as string, slug: response.body.slug as string };
  };

  const publish = async (actor: Actor, id: string, scheduledFor?: string): Promise<void> => {
    await request(app.getHttpServer())
      .post(`/api/v1/blog/articles/${id}/publish`)
      .set(auth(actor))
      .send(
        scheduledFor === undefined
          ? { status: 'PUBLISHED' }
          : { status: 'SCHEDULED', scheduledFor },
      )
      .expect(200);
  };

  describe('writing', () => {
    it('derives the slug, excerpt and reading time, and returns the body', async () => {
      const author = await createActor();

      const response = await request(app.getHttpServer())
        .post('/api/v1/blog/articles')
        .set(auth(author))
        .send({ title: 'Shipping a Monorepo', body: '## Intro\n\nThe prose goes here.' })
        .expect(201);

      expect(response.body).toMatchObject({
        slug: 'shipping-a-monorepo',
        title: 'Shipping a Monorepo',
        excerpt: 'Intro The prose goes here.',
        readingMinutes: 1,
        status: 'DRAFT',
        isAuthor: true,
        body: '## Intro\n\nThe prose goes here.',
      });
    });

    /** An author who chose a URL must not discover it was quietly suffixed. */
    it('refuses a duplicate slug with a conflict', async () => {
      const author = await createActor();
      await createArticle(author, { slug: 'the-same-url' });

      await request(app.getHttpServer())
        .post('/api/v1/blog/articles')
        .set(auth(author))
        .send({ title: 'Another title', body: 'Body', slug: 'the-same-url' })
        .expect(409);
    });

    it('rejects an empty body, an empty title and an unclosed code fence', async () => {
      const author = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/blog/articles')
        .set(auth(author))
        .send({ title: 'A title', body: '   ' })
        .expect(422);

      await request(app.getHttpServer())
        .post('/api/v1/blog/articles')
        .set(auth(author))
        .send({ title: 'ab', body: 'Body' })
        .expect(422);

      await request(app.getHttpServer())
        .post('/api/v1/blog/articles')
        .set(auth(author))
        .send({ title: 'A title', body: 'before\n```ts\nconst a = 1;' })
        .expect(422);
    });
  });

  describe('visibility', () => {
    it('hides a draft from every other account, by id and by slug', async () => {
      const author = await createActor();
      const reader = await createActor();
      const article = await createArticle(author);

      await request(app.getHttpServer())
        .get(`/api/v1/blog/articles/${article.id}`)
        .set(auth(reader))
        .expect(404);
      await request(app.getHttpServer())
        .get(`/api/v1/blog/articles/${article.slug}`)
        .set(auth(reader))
        .expect(404);

      // The author reads their own draft: that is what a preview is.
      const own = await request(app.getHttpServer())
        .get(`/api/v1/blog/articles/${article.slug}`)
        .set(auth(author))
        .expect(200);
      expect(own.body.status).toBe('DRAFT');
    });

    it('shows a published article in the archive and keeps drafts out of it', async () => {
      const author = await createActor();
      const reader = await createActor();
      const published = await createArticle(author, { title: 'Shipped and readable' });
      await createArticle(author, { title: 'Still a draft' });
      await publish(author, published.id);

      const archive = await request(app.getHttpServer())
        .get('/api/v1/blog/articles')
        .set(auth(reader))
        .expect(200);

      expect(archive.body.items.map((item: { title: string }) => item.title)).toEqual([
        'Shipped and readable',
      ]);
    });

    /** The schedule is the authority: no worker has touched the row. */
    it('makes a scheduled article readable the moment it is due', async () => {
      const author = await createActor();
      const reader = await createActor();
      const article = await createArticle(author);

      // A schedule a minute in the past is refused by the API, so the fixture is written
      // directly: the property under test is the read path, not the transition.
      await pool.query(
        `UPDATE articles SET status = 'SCHEDULED', scheduled_for = now() - interval '1 minute'
          WHERE id = $1`,
        [article.id],
      );

      const read = await request(app.getHttpServer())
        .get(`/api/v1/blog/articles/${article.slug}`)
        .set(auth(reader))
        .expect(200);
      expect(read.body.status).toBe('PUBLISHED');

      // The stored row still says what the author intended.
      const stored = await pool.query<{ status: string }>(
        'SELECT status FROM articles WHERE id = $1',
        [article.id],
      );
      expect(stored.rows[0]?.status).toBe('SCHEDULED');
    });

    it('hides the article from a blocked reader and keeps it for its author', async () => {
      const author = await createActor();
      const reader = await createActor();
      const article = await createArticle(author);
      await publish(author, article.id);

      await pool.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
        reader.accountId,
        author.accountId,
      ]);

      await request(app.getHttpServer())
        .get(`/api/v1/blog/articles/${article.slug}`)
        .set(auth(reader))
        .expect(404);

      await request(app.getHttpServer())
        .get(`/api/v1/blog/articles/${article.slug}`)
        .set(auth(author))
        .expect(200);

      const archive = await request(app.getHttpServer())
        .get('/api/v1/blog/articles')
        .set(auth(reader))
        .expect(200);
      expect(archive.body.items).toEqual([]);
    });
  });

  describe('publishing', () => {
    it('publishes, archives and refuses to resurrect', async () => {
      const author = await createActor();
      const article = await createArticle(author);

      await publish(author, article.id);

      const archived = await request(app.getHttpServer())
        .post(`/api/v1/blog/articles/${article.id}/publish`)
        .set(auth(author))
        .send({ status: 'ARCHIVED' })
        .expect(200);
      expect(archived.body.status).toBe('ARCHIVED');
      // The day it was published is kept: an archived article keeps its date.
      expect(archived.body.publishedAt).not.toBeNull();

      await request(app.getHttpServer())
        .post(`/api/v1/blog/articles/${article.id}/publish`)
        .set(auth(author))
        .send({ status: 'PUBLISHED' })
        .expect(412);
    });

    it('refuses a schedule in the past and one with no date', async () => {
      const author = await createActor();
      const article = await createArticle(author);

      await request(app.getHttpServer())
        .post(`/api/v1/blog/articles/${article.id}/publish`)
        .set(auth(author))
        .send({ status: 'SCHEDULED' })
        .expect(422);

      await request(app.getHttpServer())
        .post(`/api/v1/blog/articles/${article.id}/publish`)
        .set(auth(author))
        .send({ status: 'SCHEDULED', scheduledFor: '2020-01-01T00:00:00.000Z' })
        .expect(422);
    });

    it('schedules for the future and keeps it private until then', async () => {
      const author = await createActor();
      const reader = await createActor();
      const article = await createArticle(author);

      const scheduled = await request(app.getHttpServer())
        .post(`/api/v1/blog/articles/${article.id}/publish`)
        .set(auth(author))
        .send({
          status: 'SCHEDULED',
          scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(200);

      expect(scheduled.body).toMatchObject({ status: 'SCHEDULED', publishedAt: null });
      expect(scheduled.body.scheduledFor).not.toBeNull();

      await request(app.getHttpServer())
        .get(`/api/v1/blog/articles/${article.slug}`)
        .set(auth(reader))
        .expect(404);
    });

    it('refuses every change to an article that is not the caller\u2019s', async () => {
      const author = await createActor();
      const stranger = await createActor();
      const article = await createArticle(author);

      await request(app.getHttpServer())
        .patch(`/api/v1/blog/articles/${article.id}`)
        .set(auth(stranger))
        .send({ title: 'Mine now' })
        .expect(404);

      await request(app.getHttpServer())
        .post(`/api/v1/blog/articles/${article.id}/publish`)
        .set(auth(stranger))
        .send({ status: 'PUBLISHED' })
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/api/v1/blog/articles/${article.id}`)
        .set(auth(stranger))
        .expect(404);
    });
  });

  describe('editing', () => {
    it('recomputes the excerpt and reading time when the body grows', async () => {
      const author = await createActor();
      const article = await createArticle(author);

      const updated = await request(app.getHttpServer())
        .patch(`/api/v1/blog/articles/${article.id}`)
        .set(auth(author))
        .send({ body: 'word '.repeat(450), title: 'A longer piece' })
        .expect(200);

      expect(updated.body).toMatchObject({ title: 'A longer piece', readingMinutes: 3 });
    });

    it('refuses an edit that changes nothing', async () => {
      const author = await createActor();
      const article = await createArticle(author);

      await request(app.getHttpServer())
        .patch(`/api/v1/blog/articles/${article.id}`)
        .set(auth(author))
        .send({})
        .expect(422);
    });

    it('replaces the tag set rather than appending to it', async () => {
      const author = await createActor();
      const article = await createArticle(author, { tags: ['postgresql', 'typescript'] });

      const updated = await request(app.getHttpServer())
        .patch(`/api/v1/blog/articles/${article.id}`)
        .set(auth(author))
        .send({ tags: ['rss'] })
        .expect(200);

      expect(updated.body.tags).toEqual(['rss']);
    });
  });

  describe('filtering and the tag cloud', () => {
    it('filters by tag and by author, and counts only readable tags', async () => {
      const author = await createActor();
      const reader = await createActor();

      const live = await createArticle(author, {
        title: 'A live article',
        tags: ['postgresql', 'typescript'],
      });
      await publish(author, live.id);
      await createArticle(author, { title: 'A draft article', tags: ['secret-tag'] });

      const byTag = await request(app.getHttpServer())
        .get('/api/v1/blog/articles?tag=postgresql')
        .set(auth(reader))
        .expect(200);
      expect(byTag.body.items).toHaveLength(1);

      const byAuthor = await request(app.getHttpServer())
        .get(`/api/v1/blog/articles?author=${author.username}`)
        .set(auth(reader))
        .expect(200);
      expect(byAuthor.body.items).toHaveLength(1);

      const tags = await request(app.getHttpServer())
        .get('/api/v1/blog/tags')
        .set(auth(reader))
        .expect(200);
      const names = (tags.body.items as { tag: string }[]).map((item) => item.tag);
      expect(names).toContain('postgresql');
      // A tag that exists only on a draft would leak the draft's existence.
      expect(names).not.toContain('secret-tag');
    });

    /** `mine` is the author's workspace: every status, newest work first. */
    it('lists the caller\u2019s own articles in every status under mine=true', async () => {
      const author = await createActor();
      const other = await createActor();
      const draft = await createArticle(author, { title: 'Draft one' });
      await createArticle(other, { title: 'Not mine' });
      void draft;

      const mine = await request(app.getHttpServer())
        .get('/api/v1/blog/articles?mine=true')
        .set(auth(author))
        .expect(200);

      expect(mine.body.items.map((item: { title: string }) => item.title)).toEqual(['Draft one']);
      expect(mine.body.items[0].status).toBe('DRAFT');
    });

    it('pages the archive with a keyset cursor', async () => {
      const author = await createActor();
      const reader = await createActor();

      for (const title of ['First article', 'Second article', 'Third article']) {
        const article = await createArticle(author, { title });
        await publish(author, article.id);
      }

      const first = await request(app.getHttpServer())
        .get('/api/v1/blog/articles?limit=2')
        .set(auth(reader))
        .expect(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toBeTruthy();

      const second = await request(app.getHttpServer())
        .get(`/api/v1/blog/articles?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
        .set(auth(reader))
        .expect(200);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.nextCursor).toBeNull();

      const seen = [
        ...first.body.items.map((item: { id: string }) => item.id),
        ...second.body.items.map((item: { id: string }) => item.id),
      ];
      expect(new Set(seen).size).toBe(3);
    });
  });

  it('requires authentication on every route', async () => {
    await request(app.getHttpServer()).get('/api/v1/blog/articles').expect(401);
    await request(app.getHttpServer()).post('/api/v1/blog/articles').send({}).expect(401);
    await request(app.getHttpServer()).get('/api/v1/blog/tags').expect(401);
  });
});
