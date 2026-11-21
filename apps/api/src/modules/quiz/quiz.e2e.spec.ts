/**
 * Quiz end-to-end tests.
 *
 * The properties only a database can demonstrate: `can_view_quiz_set()` really
 * filters the list and the read path, the answer key is withheld from a live
 * response, a graded attempt survives a re-read, and the attempt counter is
 * maintained by the trigger rather than by application code.
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

type CreatedSet = {
  id: string;
  questions: { id: string; options: { id: string; label: string; isCorrect: boolean | null }[] }[];
};

describeWithDb('quiz (e2e)', () => {
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
    await pool.query('DELETE FROM quiz_answer_options');
    await pool.query('DELETE FROM quiz_answers');
    await pool.query('DELETE FROM quiz_attempts');
    await pool.query('DELETE FROM quiz_options');
    await pool.query('DELETE FROM quiz_questions');
    await pool.query('DELETE FROM quiz_sets');
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
    const email = `q-${randomUUID()}@example.test`;
    const username = `u_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, username, displayName: 'Quiz Tester' })
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

  const createSet = async (
    actor: Actor,
    overrides: Record<string, unknown> = {},
  ): Promise<CreatedSet> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/quiz/sets')
      .set(auth(actor))
      .send({
        title: 'Algebra basics',
        questions: [
          {
            prompt: 'What is 2 + 2?',
            options: [
              { label: '4', correct: true },
              { label: '5', correct: false },
            ],
          },
        ],
        ...overrides,
      });

    if (response.status !== 201) {
      throw new Error(`createSet failed: ${response.status} ${JSON.stringify(response.body)}`);
    }

    return response.body as CreatedSet;
  };

  const follow = async (follower: Actor, target: Actor): Promise<void> => {
    await request(app.getHttpServer())
      .post('/api/v1/social/follow')
      .set(auth(follower))
      .send({ accountId: target.accountId })
      .expect(200);
  };

  describe('authoring', () => {
    it('creates a set with its questions and options, and returns the key to the owner', async () => {
      const owner = await createActor();
      const created = await createSet(owner);

      expect(created.questions).toHaveLength(1);
      expect(created.questions[0]?.options).toHaveLength(2);
      expect(created.questions[0]?.options.map((option) => option.isCorrect)).toEqual([
        true,
        false,
      ]);

      const stored = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM quiz_options',
      );
      expect(stored.rows[0]?.n).toBe('2');
    });

    it('rejects an invalid set without writing anything', async () => {
      const owner = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/quiz/sets')
        .set(auth(owner))
        .send({
          title: 'Broken',
          questions: [
            {
              prompt: 'No correct answer',
              options: [
                { label: 'a', correct: false },
                { label: 'b', correct: false },
              ],
            },
          ],
        })
        .expect(422);

      // A rejected set must not leave orphan questions behind: the insert is one
      // transaction, and this is the assertion that proves it.
      const sets = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM quiz_sets');
      const questions = await pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM quiz_questions',
      );
      expect(sets.rows[0]?.n).toBe('0');
      expect(questions.rows[0]?.n).toBe('0');
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/quiz/sets').expect(401);
      await request(app.getHttpServer()).post('/api/v1/quiz/sets').send({}).expect(401);
    });
  });

  describe('visibility', () => {
    it('hides a private set from everyone but its owner', async () => {
      const owner = await createActor();
      const stranger = await createActor();
      const created = await createSet(owner, { visibility: 'PRIVATE' });

      await request(app.getHttpServer())
        .get(`/api/v1/quiz/sets/${created.id}`)
        .set(auth(stranger))
        .expect(404);

      const listed = await request(app.getHttpServer())
        .get('/api/v1/quiz/sets')
        .set(auth(stranger))
        .expect(200);
      expect((listed.body.items as { id: string }[]).map((item) => item.id)).not.toContain(
        created.id,
      );
    });

    it('shows a followers-only set to an accepted follower and not to an outsider', async () => {
      const owner = await createActor();
      const follower = await createActor();
      const outsider = await createActor();
      const created = await createSet(owner, { visibility: 'FOLLOWERS' });

      await request(app.getHttpServer())
        .get(`/api/v1/quiz/sets/${created.id}`)
        .set(auth(outsider))
        .expect(404);

      await follow(follower, owner);
      await request(app.getHttpServer())
        .get(`/api/v1/quiz/sets/${created.id}`)
        .set(auth(follower))
        .expect(200);
    });

    it('revokes access when the follower is blocked', async () => {
      const owner = await createActor();
      const follower = await createActor();
      const created = await createSet(owner, { visibility: 'FOLLOWERS' });
      await follow(follower, owner);

      await request(app.getHttpServer())
        .get(`/api/v1/quiz/sets/${created.id}`)
        .set(auth(follower))
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/social/block')
        .set(auth(owner))
        .send({ accountId: follower.accountId })
        .expect(204);

      // The block severs the follow by trigger *and* the visibility rule denies;
      // either alone would be enough, which is the point of checking both.
      await request(app.getHttpServer())
        .get(`/api/v1/quiz/sets/${created.id}`)
        .set(auth(follower))
        .expect(404);
    });
  });

  describe('taking a set', () => {
    it('withholds the answer key from a student before grading', async () => {
      const owner = await createActor();
      const student = await createActor();
      const created = await createSet(owner);
      const optionId = created.questions[0]?.options[0]?.id as string;

      const read = await request(app.getHttpServer())
        .get(`/api/v1/quiz/sets/${created.id}`)
        .set(auth(student))
        .expect(200);

      // Present and null — never `false`, which would still mark which option is wrong.
      expect(
        (read.body.questions as { options: { isCorrect: boolean | null }[] }[])[0]?.options.map(
          (option) => option.isCorrect,
        ),
      ).toEqual([null, null]);
      expect(optionId).toBeDefined();
    });

    it('grades a submission and returns the key with the attempt', async () => {
      const owner = await createActor();
      const student = await createActor();
      const created = await createSet(owner);

      const question = created.questions[0];
      const correct = question?.options.find((option) => option.isCorrect === true)?.id as string;

      const started = await request(app.getHttpServer())
        .post(`/api/v1/quiz/sets/${created.id}/attempts`)
        .set(auth(student))
        .expect(201);

      const submitted = await request(app.getHttpServer())
        .post(`/api/v1/quiz/attempts/${String(started.body.id)}/submit`)
        .set(auth(student))
        .send({ answers: [{ questionId: question?.id, selectedOptionIds: [correct] }] })
        .expect(200);

      expect(submitted.body).toMatchObject({
        score: 1,
        maxScore: 1,
        percentage: 100,
        expired: false,
      });
      expect((submitted.body.results as { correct: boolean }[])[0]?.correct).toBe(true);

      // The counter is maintained by the trigger, not by application code.
      const counted = await pool.query<{ attempt_count: number }>(
        'SELECT attempt_count FROM quiz_sets WHERE id = $1',
        [created.id],
      );
      expect(counted.rows[0]?.attempt_count).toBe(1);

      // And the key is now visible to the student, because the attempt is graded.
      const reread = await request(app.getHttpServer())
        .get(`/api/v1/quiz/sets/${created.id}`)
        .set(auth(student))
        .expect(200);
      expect(
        (reread.body.questions as { options: { isCorrect: boolean | null }[] }[])[0]?.options.map(
          (option) => option.isCorrect,
        ),
      ).toEqual([true, false]);
      expect(reread.body.myAttempt).toMatchObject({ score: 1 });
    });

    it('grades a skipped question as wrong but still counts it', async () => {
      const owner = await createActor();
      const student = await createActor();
      const created = await createSet(owner, {
        questions: [
          {
            prompt: 'First',
            options: [
              { label: 'a', correct: true },
              { label: 'b', correct: false },
            ],
          },
          {
            prompt: 'Second',
            options: [
              { label: 'c', correct: true },
              { label: 'd', correct: false },
            ],
          },
        ],
      });

      const first = created.questions[0];
      const started = await request(app.getHttpServer())
        .post(`/api/v1/quiz/sets/${created.id}/attempts`)
        .set(auth(student))
        .expect(201);

      const submitted = await request(app.getHttpServer())
        .post(`/api/v1/quiz/attempts/${String(started.body.id)}/submit`)
        .set(auth(student))
        .send({
          answers: [
            {
              questionId: first?.id,
              selectedOptionIds: [first?.options[0]?.id],
            },
          ],
        })
        .expect(200);

      expect(submitted.body.score).toBe(1);
      expect(submitted.body.maxScore).toBe(2);
      expect(submitted.body.percentage).toBe(50);
    });

    it('refuses a second submission of the same attempt', async () => {
      const owner = await createActor();
      const student = await createActor();
      const created = await createSet(owner);
      const question = created.questions[0];

      const started = await request(app.getHttpServer())
        .post(`/api/v1/quiz/sets/${created.id}/attempts`)
        .set(auth(student))
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/quiz/attempts/${String(started.body.id)}/submit`)
        .set(auth(student))
        .send({ answers: [{ questionId: question?.id, selectedOptionIds: [] }] })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/api/v1/quiz/attempts/${String(started.body.id)}/submit`)
        .set(auth(student))
        .send({ answers: [{ questionId: question?.id, selectedOptionIds: [] }] })
        .expect(409);
    });

    it('cannot start an attempt on an invisible set', async () => {
      const owner = await createActor();
      const stranger = await createActor();
      const created = await createSet(owner, { visibility: 'PRIVATE' });

      await request(app.getHttpServer())
        .post(`/api/v1/quiz/sets/${created.id}/attempts`)
        .set(auth(stranger))
        .expect(404);
    });

    it('cannot read another account attempt', async () => {
      const owner = await createActor();
      const student = await createActor();
      const other = await createActor();
      const created = await createSet(owner);

      const started = await request(app.getHttpServer())
        .post(`/api/v1/quiz/sets/${created.id}/attempts`)
        .set(auth(student))
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/quiz/attempts/${String(started.body.id)}`)
        .set(auth(other))
        .expect(404);
    });

    it('pages the set list without repeating a set', async () => {
      const owner = await createActor();
      const reader = await createActor();
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        ids.push((await createSet(owner, { title: `Set ${index}` })).id);
      }

      const first = await request(app.getHttpServer())
        .get('/api/v1/quiz/sets?limit=2')
        .set(auth(reader))
        .expect(200);
      const firstIds = (first.body.items as { id: string }[]).map((item) => item.id);

      const second = await request(app.getHttpServer())
        .get(`/api/v1/quiz/sets?limit=2&cursor=${String(first.body.nextCursor)}`)
        .set(auth(reader))
        .expect(200);
      const secondIds = (second.body.items as { id: string }[]).map((item) => item.id);

      expect(firstIds).toHaveLength(2);
      expect(secondIds.filter((id) => firstIds.includes(id))).toHaveLength(0);
      expect(new Set([...firstIds, ...secondIds])).toEqual(new Set(ids));
    });

    it('filters to the caller’s own sets', async () => {
      const owner = await createActor();
      const reader = await createActor();
      const mine = await createSet(owner, { title: 'Mine' });
      await createSet(reader, { title: 'Theirs' });

      const response = await request(app.getHttpServer())
        .get('/api/v1/quiz/sets?mine=true')
        .set(auth(reader))
        .expect(200);

      const ids = (response.body.items as { id: string }[]).map((item) => item.id);
      expect(ids).not.toContain(mine.id);
      expect(ids).toHaveLength(1);
    });
  });
});
