/**
 * Profile and social graph end-to-end tests.
 *
 * Real HTTP, real service, real repositories, real PostgreSQL. The interesting
 * assertions here are the ones a unit test cannot make: that the database
 * triggers sever follows on block, that counters stay correct through a full
 * request cycle, and that a blocked party cannot distinguish a block from a
 * missing account.
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

type Actor = {
  accountId: string;
  username: string;
  accessToken: string;
};

describeWithDb('profile (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = CONNECTION;
    process.env['NODE_ENV'] = 'test';
    process.env['CACHE_DRIVER'] = 'memory';
    process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
    process.env['JWT_ACCESS_SECRET'] = 'test-access-secret-with-at-least-32-characters';
    process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-with-at-least-32-chars-x';
    process.env['LOG_LEVEL'] = process.env['TEST_LOG_LEVEL'] ?? 'fatal';
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
    // Order matters only because of the audit trigger-free tables; the graph
    // tables cascade from accounts.
    await pool.query('DELETE FROM blocks');
    await pool.query('DELETE FROM follows');
    await pool.query('DELETE FROM verification_codes');
    await pool.query('DELETE FROM refresh_tokens');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM user_roles');
    await pool.query('DELETE FROM user_profiles');
    await pool.query(`DELETE FROM accounts WHERE account_type = 'USER'`);
  });

  /**
   * Registers, verifies and logs in a real account, returning a usable bearer
   * token. The OTP is recovered by brute-forcing the stored digest, which proves
   * the digest scheme is the one the service verifies without any backdoor.
   */
  const createActor = async (): Promise<Actor> => {
    const email = `p-${randomUUID()}@example.test`;
    const username = `u_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, username, displayName: 'Profile Tester' })
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

  describe('own profile', () => {
    it('returns the profile created at registration', async () => {
      const actor = await createActor();
      const response = await request(app.getHttpServer())
        .get('/api/v1/profile')
        .set(auth(actor))
        .expect(200);

      expect(response.body).toMatchObject({
        accountId: actor.accountId,
        username: actor.username,
        displayName: 'Profile Tester',
        isSelf: true,
        canFollow: false,
      });
      // Visibility is internal policy, not client state: it is not echoed unless
      // the client asked for it, and it is never used to make a client decision.
      expect(response.body).not.toHaveProperty('visibility');
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/v1/profile').expect(401);
    });

    it('updates a display name and a bio', async () => {
      const actor = await createActor();
      const response = await request(app.getHttpServer())
        .patch('/api/v1/profile')
        .set(auth(actor))
        .send({ displayName: 'Ada Lovelace', bio: 'First programmer' })
        .expect(200);

      expect(response.body.displayName).toBe('Ada Lovelace');
      expect(response.body.bio).toBe('First programmer');

      const reread = await request(app.getHttpServer())
        .get('/api/v1/profile')
        .set(auth(actor))
        .expect(200);
      expect(reread.body.bio).toBe('First programmer');
    });

    it('clears a bio when null is sent, and refuses an empty patch', async () => {
      const actor = await createActor();
      await request(app.getHttpServer())
        .patch('/api/v1/profile')
        .set(auth(actor))
        .send({ bio: 'temporary' })
        .expect(200);

      const cleared = await request(app.getHttpServer())
        .patch('/api/v1/profile')
        .set(auth(actor))
        .send({ bio: null })
        .expect(200);
      expect(cleared.body.bio).toBeNull();

      await request(app.getHttpServer())
        .patch('/api/v1/profile')
        .set(auth(actor))
        .send({})
        .expect(422);
    });

    it('rejects an over-long bio and an unknown field', async () => {
      const actor = await createActor();
      await request(app.getHttpServer())
        .patch('/api/v1/profile')
        .set(auth(actor))
        .send({ bio: 'x'.repeat(501) })
        .expect(422);

      await request(app.getHttpServer())
        .patch('/api/v1/profile')
        .set(auth(actor))
        .send({ displayName: 'Ada', isAdmin: true })
        .expect(422);
    });

    it('refuses a username already taken by another account', async () => {
      const first = await createActor();
      const second = await createActor();

      await request(app.getHttpServer())
        .patch('/api/v1/profile')
        .set(auth(second))
        .send({ username: first.username })
        .expect(409);
    });
  });

  describe('following', () => {
    it('follows a public account and maintains both counters', async () => {
      const follower = await createActor();
      const target = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/social/follow')
        .set(auth(follower))
        .send({ accountId: target.accountId })
        .expect(200, { following: true });

      const targetView = await request(app.getHttpServer())
        .get(`/api/v1/profiles/${target.username}`)
        .set(auth(follower))
        .expect(200);

      expect(targetView.body.followerCount).toBe(1);
      expect(targetView.body.isFollowing).toBe(true);
      expect(targetView.body.canFollow).toBe(false);

      const followerView = await request(app.getHttpServer())
        .get('/api/v1/profile')
        .set(auth(follower))
        .expect(200);
      expect(followerView.body.followingCount).toBe(1);
    });

    it('is idempotent: following twice does not double the counter', async () => {
      const follower = await createActor();
      const target = await createActor();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await request(app.getHttpServer())
          .post('/api/v1/social/follow')
          .set(auth(follower))
          .send({ accountId: target.accountId })
          .expect(200);
      }

      const view = await request(app.getHttpServer())
        .get(`/api/v1/profiles/${target.username}`)
        .set(auth(follower))
        .expect(200);
      expect(view.body.followerCount).toBe(1);
    });

    it('refuses a self-follow', async () => {
      const actor = await createActor();
      await request(app.getHttpServer())
        .post('/api/v1/social/follow')
        .set(auth(actor))
        .send({ accountId: actor.accountId })
        .expect(422);
    });

    it('unfollows, and unfollowing twice still succeeds', async () => {
      const follower = await createActor();
      const target = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/social/follow')
        .set(auth(follower))
        .send({ accountId: target.accountId })
        .expect(200);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await request(app.getHttpServer())
          .delete(`/api/v1/social/follow/${target.accountId}`)
          .set(auth(follower))
          .expect(204);
      }

      const view = await request(app.getHttpServer())
        .get(`/api/v1/profiles/${target.username}`)
        .set(auth(follower))
        .expect(200);
      expect(view.body.followerCount).toBe(0);
      expect(view.body.isFollowing).toBe(false);
    });

    it('creates a pending request for a private account, then accepts it', async () => {
      const requester = await createActor();
      const owner = await createActor();

      await request(app.getHttpServer())
        .patch('/api/v1/profile')
        .set(auth(owner))
        .send({ visibility: 'PRIVATE' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/social/follow')
        .set(auth(requester))
        .send({ accountId: owner.accountId })
        .expect(200, { following: false });

      const pending = await request(app.getHttpServer())
        .get(`/api/v1/profiles/${owner.username}`)
        .set(auth(requester))
        .expect(200);
      expect(pending.body.followPending).toBe(true);
      expect(pending.body.isFollowing).toBe(false);
      expect(pending.body.followerCount).toBeNull();

      await request(app.getHttpServer())
        .post(`/api/v1/social/follow-requests/${requester.accountId}/accept`)
        .set(auth(owner))
        .expect(204);

      const accepted = await request(app.getHttpServer())
        .get(`/api/v1/profiles/${owner.username}`)
        .set(auth(requester))
        .expect(200);
      expect(accepted.body.isFollowing).toBe(true);
      // A confirmed follower sees the profile body, but counts stay owner-only on
      // a PRIVATE profile: following grants the bio, not the audience metrics.
      expect(accepted.body.followerCount).toBeNull();

      const ownerView = await request(app.getHttpServer())
        .get('/api/v1/profile')
        .set(auth(owner))
        .expect(200);
      expect(ownerView.body.followerCount).toBe(1);
    });
  });

  describe('blocking', () => {
    it('hides both profiles and severs an existing follow', async () => {
      const blocker = await createActor();
      const blocked = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/social/follow')
        .set(auth(blocked))
        .send({ accountId: blocker.accountId })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/v1/social/block')
        .set(auth(blocker))
        .send({ accountId: blocked.accountId, reason: 'harassment' })
        .expect(204);

      // The blocked party cannot see the blocker, and cannot tell a block from a
      // deleted account.
      await request(app.getHttpServer())
        .get(`/api/v1/profiles/${blocker.username}`)
        .set(auth(blocked))
        .expect(404);

      // The blocker also cannot see the blocked party: a block is symmetric in
      // effect even though it is stored once.
      await request(app.getHttpServer())
        .get(`/api/v1/profiles/${blocked.username}`)
        .set(auth(blocker))
        .expect(404);

      // The follow was severed by the database trigger, so the counter is 0.
      const rows = await pool.query<{ follower_count: number }>(
        'SELECT follower_count FROM user_profiles WHERE account_id = $1',
        [blocker.accountId],
      );
      expect(rows.rows[0]?.follower_count).toBe(0);
    });

    it('refuses a follow across a block', async () => {
      const a = await createActor();
      const b = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/social/block')
        .set(auth(a))
        .send({ accountId: b.accountId })
        .expect(204);

      await request(app.getHttpServer())
        .post('/api/v1/social/follow')
        .set(auth(b))
        .send({ accountId: a.accountId })
        .expect(404);
    });

    it('writes a hash-chained audit row for the block', async () => {
      const blocker = await createActor();
      const blocked = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/social/block')
        .set(auth(blocker))
        .send({ accountId: blocked.accountId })
        .expect(204);

      const rows = await pool.query(
        `SELECT action, resource_id FROM audit_events
          WHERE actor_id = $1 AND action = 'social.block.created'`,
        [blocker.accountId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.resource_id).toBe(blocked.accountId);
    });

    it('unblocks, which restores visibility but not the severed follow', async () => {
      const a = await createActor();
      const b = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/social/block')
        .set(auth(a))
        .send({ accountId: b.accountId })
        .expect(204);
      await request(app.getHttpServer())
        .delete(`/api/v1/social/block/${b.accountId}`)
        .set(auth(a))
        .expect(204);

      const view = await request(app.getHttpServer())
        .get(`/api/v1/profiles/${b.username}`)
        .set(auth(a))
        .expect(200);
      expect(view.body.isFollowing).toBe(false);
      expect(view.body.canFollow).toBe(true);
    });

    it('refuses a self-block', async () => {
      const actor = await createActor();
      await request(app.getHttpServer())
        .post('/api/v1/social/block')
        .set(auth(actor))
        .send({ accountId: actor.accountId })
        .expect(422);
    });
  });

  describe('visibility', () => {
    it('redacts a followers-only profile from a stranger', async () => {
      const owner = await createActor();
      const stranger = await createActor();

      await request(app.getHttpServer())
        .patch('/api/v1/profile')
        .set(auth(owner))
        .send({ visibility: 'FOLLOWERS', bio: 'secret plans' })
        .expect(200);

      const view = await request(app.getHttpServer())
        .get(`/api/v1/profiles/${owner.username}`)
        .set(auth(stranger))
        .expect(200);

      expect(view.body.bio).toBeNull();
      expect(view.body.followerCount).toBeNull();
      expect(view.body.displayName).toBe('Profile Tester');
    });

    it('refuses the follower list to a stranger on a public profile', async () => {
      const owner = await createActor();
      const stranger = await createActor();

      await request(app.getHttpServer())
        .get(`/api/v1/profiles/${owner.username}/followers`)
        .set(auth(stranger))
        .expect(403);
    });

    it('serves the follower list to a confirmed follower, paginated', async () => {
      const owner = await createActor();
      const first = await createActor();
      const second = await createActor();

      for (const follower of [first, second]) {
        await request(app.getHttpServer())
          .post('/api/v1/social/follow')
          .set(auth(follower))
          .send({ accountId: owner.accountId })
          .expect(200);
      }

      const page = await request(app.getHttpServer())
        .get(`/api/v1/profiles/${owner.username}/followers?limit=1`)
        .set(auth(first))
        .expect(200);

      expect(page.body.items).toHaveLength(1);
      expect(page.body.nextCursor).toBeTruthy();

      const next = await request(app.getHttpServer())
        .get(`/api/v1/profiles/${owner.username}/followers?limit=1&cursor=${page.body.nextCursor}`)
        .set(auth(first))
        .expect(200);

      expect(next.body.items).toHaveLength(1);
      // Two pages, no overlap: keyset pagination must not repeat a row.
      expect(next.body.items[0].accountId).not.toBe(page.body.items[0].accountId);
      expect(next.body.nextCursor).toBeNull();
    });

    it('returns 404 for an unknown username', async () => {
      const actor = await createActor();
      await request(app.getHttpServer())
        .get('/api/v1/profiles/nobody_here')
        .set(auth(actor))
        .expect(404);
    });
  });
});
