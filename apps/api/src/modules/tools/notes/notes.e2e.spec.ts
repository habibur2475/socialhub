/**
 * Notes end-to-end tests.
 *
 * The properties only a database and a real HTTP stack show: a note is readable only by its
 * author, the list is ordered by the index (pinned first, then newest edit) rather than by
 * whatever the query planner felt like, the cursor pages without skipping or repeating a
 * row while notes are being edited, and a delete leaves no tombstone behind.
 */

import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { RequestMethod, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../../app.module.js';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter.js';
import { MemoryCache } from '../../../common/cache/memory-cache.js';
import { CACHE } from '../../../database/cache.provider.js';
import { JsonLogger } from '../../../common/logging/logger.js';

const CONNECTION = process.env['TEST_DATABASE_URL'];
const describeWithDb = CONNECTION === undefined ? describe.skip : describe;

const PASSWORD = 'correct-horse-battery';

type Actor = { accountId: string; username: string; accessToken: string };

describeWithDb('tools notes (e2e)', () => {
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
    await pool.query('DELETE FROM notes');
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
    const email = `n-${randomUUID()}@example.test`;
    const username = `u_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, username, displayName: 'Notes Tester' })
      .expect(202);

    const { rows } = await pool.query<{ code_digest: Buffer; id: string }>(
      `SELECT vc.code_digest, a.id FROM verification_codes vc
         JOIN accounts a ON a.id = vc.account_id
        WHERE a.email = $1 AND vc.purpose = 'EMAIL_VERIFY'`,
      [email],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('verification code missing');

    const { digestOtp } = await import('../../auth/domain/one-time-code.js');
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

  const createNote = async (
    actor: Actor,
    body = 'Shopping\nmilk\neggs',
    pinned?: boolean,
  ): Promise<{ id: string; title: string }> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/tools/notes')
      .set(auth(actor))
      .send(pinned === undefined ? { body } : { body, pinned })
      .expect(201);

    return { id: response.body.id as string, title: response.body.title as string };
  };

  describe('the shape of a note', () => {
    it('derives the title from the first line and counts the words', async () => {
      const owner = await createActor();

      const response = await request(app.getHttpServer())
        .post('/api/v1/tools/notes')
        .set(auth(owner))
        .send({ body: 'Shopping\nmilk\neggs' })
        .expect(201);

      expect(response.body).toMatchObject({
        title: 'Shopping',
        body: 'Shopping\nmilk\neggs',
        pinned: false,
        words: 3,
      });
      expect(response.body.createdAt).toMatch(/Z$/);
    });

    it('refuses an empty note and a client-supplied title', async () => {
      const owner = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/tools/notes')
        .set(auth(owner))
        .send({ body: '   ' })
        .expect(422);

      // `title` is not part of the contract: accepting it would be a second source of truth.
      await request(app.getHttpServer())
        .post('/api/v1/tools/notes')
        .set(auth(owner))
        .send({ body: 'a note', title: 'mine' })
        .expect(422);
    });

    it('requires a token', async () => {
      await request(app.getHttpServer()).get('/api/v1/tools/notes').expect(401);
    });
  });

  describe('ownership', () => {
    it('hides a note from every other account, on every route', async () => {
      const owner = await createActor();
      const stranger = await createActor();
      const note = await createNote(owner);

      await request(app.getHttpServer())
        .get(`/api/v1/tools/notes/${note.id}`)
        .set(auth(stranger))
        .expect(404);

      await request(app.getHttpServer())
        .patch(`/api/v1/tools/notes/${note.id}`)
        .set(auth(stranger))
        .send({ pinned: true })
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/api/v1/tools/notes/${note.id}`)
        .set(auth(stranger))
        .expect(404);

      const list = await request(app.getHttpServer())
        .get('/api/v1/tools/notes')
        .set(auth(stranger))
        .expect(200);
      expect(list.body.items).toEqual([]);

      // 404 rather than 403: a 403 would confirm the id exists.
      await request(app.getHttpServer())
        .get(`/api/v1/tools/notes/${note.id}`)
        .set(auth(owner))
        .expect(200);
    });
  });

  describe('the list', () => {
    it('puts pinned notes first, then the newest edit', async () => {
      const owner = await createActor();
      const pinned = await createNote(owner, 'Pinned one', true);
      const first = await createNote(owner, 'First note');
      const second = await createNote(owner, 'Second note');

      // Move the pinned note back in time so only the pin can explain its position.
      await pool.query(`UPDATE notes SET updated_at = now() - interval '1 hour' WHERE id = $1`, [
        pinned.id,
      ]);

      const response = await request(app.getHttpServer())
        .get('/api/v1/tools/notes')
        .set(auth(owner))
        .expect(200);

      expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([
        pinned.id,
        second.id,
        first.id,
      ]);
      expect(response.body.total).toBe(3);
    });

    it('filters by pin state and searches title and body', async () => {
      const owner = await createActor();
      await createNote(owner, 'Shopping\nmilk', true);
      await createNote(owner, 'Work\ncall the bank');

      const pinned = await request(app.getHttpServer())
        .get('/api/v1/tools/notes?pinned=true')
        .set(auth(owner))
        .expect(200);
      expect(pinned.body.items).toHaveLength(1);

      const search = await request(app.getHttpServer())
        .get('/api/v1/tools/notes?q=BANK')
        .set(auth(owner))
        .expect(200);
      expect(search.body.items).toHaveLength(1);
      expect(search.body.items[0].title).toBe('Work');

      const none = await request(app.getHttpServer())
        .get('/api/v1/tools/notes?q=nothing-matches-this')
        .set(auth(owner))
        .expect(200);
      expect(none.body.items).toEqual([]);
    });

    it('pages without repeating a note that was edited between pages', async () => {
      const owner = await createActor();
      const notes = [];
      for (let index = 0; index < 5; index += 1) {
        notes.push(await createNote(owner, `Note ${index}\nbody ${index}`));
      }

      const first = await request(app.getHttpServer())
        .get('/api/v1/tools/notes?limit=2')
        .set(auth(owner))
        .expect(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      // Editing a note that is already on page one must not push it into page two.
      await request(app.getHttpServer())
        .patch(`/api/v1/tools/notes/${notes[4]?.id ?? ''}`)
        .set(auth(owner))
        .send({ body: 'Note 4 edited\nbody 4' })
        .expect(200);

      const second = await request(app.getHttpServer())
        .get(`/api/v1/tools/notes?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
        .set(auth(owner))
        .expect(200);

      const firstIds = first.body.items.map((item: { id: string }) => item.id);
      const secondIds = second.body.items.map((item: { id: string }) => item.id);
      expect(secondIds.filter((id: string) => firstIds.includes(id))).toEqual([]);
    });
  });

  describe('editing', () => {
    it('re-derives the title when the body changes, and leaves it alone for a pin', async () => {
      const owner = await createActor();
      const note = await createNote(owner, 'Shopping\nmilk');

      const pinned = await request(app.getHttpServer())
        .patch(`/api/v1/tools/notes/${note.id}`)
        .set(auth(owner))
        .send({ pinned: true })
        .expect(200);
      expect(pinned.body).toMatchObject({ pinned: true, title: 'Shopping' });

      const renamed = await request(app.getHttpServer())
        .patch(`/api/v1/tools/notes/${note.id}`)
        .set(auth(owner))
        .send({ body: 'Groceries\neggs' })
        .expect(200);
      expect(renamed.body).toMatchObject({ title: 'Groceries', pinned: true });
    });

    it('refuses an empty patch and an emptied body', async () => {
      const owner = await createActor();
      const note = await createNote(owner);

      await request(app.getHttpServer())
        .patch(`/api/v1/tools/notes/${note.id}`)
        .set(auth(owner))
        .send({})
        .expect(422);

      await request(app.getHttpServer())
        .patch(`/api/v1/tools/notes/${note.id}`)
        .set(auth(owner))
        .send({ body: '   ' })
        .expect(422);
    });

    it('answers 404 for a note that does not exist', async () => {
      const owner = await createActor();
      await request(app.getHttpServer())
        .patch(`/api/v1/tools/notes/${randomUUID()}`)
        .set(auth(owner))
        .send({ pinned: true })
        .expect(404);
    });
  });

  describe('deleting', () => {
    it('deletes for real and leaves no trace in the list', async () => {
      const owner = await createActor();
      const note = await createNote(owner);

      await request(app.getHttpServer())
        .delete(`/api/v1/tools/notes/${note.id}`)
        .set(auth(owner))
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/v1/tools/notes/${note.id}`)
        .set(auth(owner))
        .expect(404);

      const list = await request(app.getHttpServer())
        .get('/api/v1/tools/notes')
        .set(auth(owner))
        .expect(200);
      expect(list.body).toMatchObject({ items: [], total: 0 });

      const { rows } = await pool.query('SELECT id FROM notes WHERE id = $1', [note.id]);
      expect(rows).toEqual([]);
    });
  });
});
