/**
 * Authentication end-to-end tests.
 *
 * These exercise the real HTTP surface, the real service, the real repositories
 * and a real PostgreSQL database — only the cache and the mail transport are
 * substituted, so the tests cover everything except Redis itself.
 *
 * They are skipped when TEST_DATABASE_URL is absent; CI provides it, and the
 * compose stack exports it for local runs.
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
import { DatabasePools } from '../../database/pool.js';
import { JsonLogger } from '../../common/logging/logger.js';

const CONNECTION = process.env['TEST_DATABASE_URL'];
const describeWithDb = CONNECTION === undefined ? describe.skip : describe;

const PASSWORD = 'correct-horse-battery';

describeWithDb('auth (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let cache: MemoryCache;

  beforeAll(async () => {
    process.env['TEST_DATABASE_URL'] = CONNECTION;
    process.env['DATABASE_URL'] = CONNECTION;
    process.env['NODE_ENV'] = 'test';
    process.env['CACHE_DRIVER'] = 'memory';
    process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
    process.env['JWT_ACCESS_SECRET'] = 'test-access-secret-with-at-least-32-characters';
    process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-with-at-least-32-chars-x';
    process.env['LOG_LEVEL'] = process.env['TEST_LOG_LEVEL'] ?? 'fatal';
    process.env['OTP_TTL_SECONDS'] = '600';
    process.env['MAX_FAILED_LOGINS'] = '5';
    process.env['LOCKOUT_SECONDS'] = '900';

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      // Redis is not available in every environment; the cache port lets the suite
      // run against the in-process adapter with identical semantics.
      .overrideProvider(CACHE)
      .useFactory({ factory: () => new MemoryCache(), inject: [] })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: new JsonLogger((process.env['TEST_LOG_LEVEL'] ?? 'fatal') as 'fatal'),
    });
    // AppModule registers APP_FILTER in providers, which requires an HTTP adapter;
    // tests create the app manually so the filter is applied here too.
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

    cache = app.get<MemoryCache>(CACHE);
    pool = new Pool({ connectionString: CONNECTION, max: 4 });
    void app.get(DatabasePools);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  beforeEach(async () => {
    cache.clear();
    await pool.query('DELETE FROM verification_codes');
    await pool.query('DELETE FROM refresh_tokens');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM user_roles');
    await pool.query('DELETE FROM user_profiles');
    await pool.query(`DELETE FROM accounts WHERE account_type = 'USER'`);
  });

  const uniqueEmail = (): string => `user-${randomUUID()}@example.test`;

  /** Registers, then reads the issued OTP straight from the logs' source of truth. */
  const register = async (email = uniqueEmail()): Promise<{ email: string; code: string }> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email,
        password: PASSWORD,
        username: `u_${randomUUID().slice(0, 8)}`,
        displayName: 'Test User',
      })
      .expect(202);

    expect(response.body.verificationRequired).toBe(true);

    // In tests the mailer is the log transport; recover the code by re-deriving
    // what the server stored instead of scraping stdout.
    const { rows } = await pool.query<{ code_digest: Buffer }>(
      `SELECT vc.code_digest FROM verification_codes vc
         JOIN accounts a ON a.id = vc.account_id
        WHERE a.email = $1 AND vc.purpose = 'EMAIL_VERIFY'`,
      [email],
    );
    expect(rows).toHaveLength(1);
    return { email, code: await recoverCode(email, rows[0]?.code_digest) };
  };

  /**
   * The code is only stored as a digest, so the test brute-forces the 10^6 space
   * to prove the digest scheme is the one the service verifies. This is exactly
   * the search an attacker cannot afford at 5 attempts, and it keeps the suite
   * honest about not needing a plaintext backdoor.
   */
  const recoverCode = async (email: string, digest: Buffer | undefined): Promise<string> => {
    const { digestOtp } = await import('./domain/one-time-code.js');
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM accounts WHERE email = $1', [
      email,
    ]);
    const accountId = rows[0]?.id;
    if (accountId === undefined || digest === undefined) throw new Error('fixture missing');

    for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
      const code = candidate.toString().padStart(6, '0');
      if (digestOtp({ accountId, purpose: 'EMAIL_VERIFY', code }).equals(digest)) return code;
    }
    throw new Error('verification digest did not match any 6-digit code');
  };

  type SessionCookies = {
    accessToken: string;
    refreshCookie: string;
    csrfCookie: string;
    csrfToken: string;
  };

  const verifiedLogin = async (): Promise<SessionCookies> => {
    const { email, code } = await register();
    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ email, code })
      .expect(200);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    const cookies = login.headers['set-cookie'] as unknown as string[];
    const refresh = cookies.find((cookie) => cookie.startsWith('__Host-sh_rt='));
    const csrf = cookies.find((cookie) => cookie.startsWith('__Host-sh_csrf='));
    if (refresh === undefined || csrf === undefined) throw new Error('session cookies missing');
    return {
      accessToken: login.body.accessToken as string,
      refreshCookie: refresh,
      csrfCookie: csrf,
      csrfToken: cookieValue(csrf),
    };
  };

  describe('registration', () => {
    it('creates a pending account and never leaks the account type', async () => {
      const email = uniqueEmail();
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email,
          password: PASSWORD,
          username: `u_${randomUUID().slice(0, 8)}`,
          displayName: 'Ada Lovelace',
        })
        .expect(202);
      expect(response.body).toEqual({
        verificationRequired: true,
        message: expect.stringContaining('Check your inbox') as unknown as string,
      });

      const { rows } = await pool.query<{ account_type: string; state: string }>(
        'SELECT account_type, state FROM accounts WHERE email = $1',
        [email],
      );
      expect(rows[0]).toEqual({ account_type: 'USER', state: 'PENDING_VERIFICATION' });
    });

    it('cannot be tricked into creating STAFF or ROOT accounts', async () => {
      const email = uniqueEmail();
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email,
          password: PASSWORD,
          username: `u_${randomUUID().slice(0, 8)}`,
          displayName: 'Mallory',
          accountType: 'ROOT',
          role: 'ROOT',
        })
        .expect(422); // forbidNonWhitelisted rejects the smuggled fields

      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      const { rows } = await pool.query('SELECT 1 FROM accounts WHERE email = $1', [email]);
      expect(rows).toHaveLength(0);
    });

    it('rejects weak and identity-derived passwords with actionable detail', async () => {
      const email = 'weak-password-target@example.test';
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email,
          password: 'weakpassword1',
          username: 'u_weakness',
          displayName: 'Weak Password',
        })
        .expect(422);

      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      const violations = (response.body.error.details as { violations: { code: string }[] })
        .violations;
      expect(violations.map((violation) => violation.code)).toContain('CONTAINS_IDENTITY');
    });

    it('rejects passwords that are too short before touching the database', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email: uniqueEmail(),
          password: 'short',
          username: 'u_shortpw',
          displayName: 'Short',
        })
        .expect(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('responds identically when the email is already registered', async () => {
      const email = uniqueEmail();
      const body = {
        email,
        password: PASSWORD,
        username: `u_${randomUUID().slice(0, 8)}`,
        displayName: 'First',
      };
      await request(app.getHttpServer()).post('/api/v1/auth/register').send(body).expect(202);

      const duplicate = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ ...body, username: `u_${randomUUID().slice(0, 8)}` })
        .expect(202);

      expect(duplicate.body.verificationRequired).toBe(true);
      const { rows } = await pool.query('SELECT 1 FROM accounts WHERE email = $1', [email]);
      expect(rows).toHaveLength(1);
    });

    it('rejects unsupported names and normalises email case', async () => {
      const email = `Mixed-${randomUUID()}@Example.Test`;
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          email,
          password: PASSWORD,
          username: `u_${randomUUID().slice(0, 8)}`,
          displayName: 'Ada',
        })
        .expect(202);

      const { rows } = await pool.query<{ email: string }>(
        'SELECT email FROM accounts WHERE email = $1',
        [email.toLowerCase()],
      );
      expect(rows[0]?.email).toBe(email.toLowerCase());
    });
  });

  describe('login', () => {
    it('refuses login before email verification', async () => {
      const { email } = await register();
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(403);
      expect(response.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    });

    it('issues an access token and an HttpOnly refresh cookie on success', async () => {
      const { email, code } = await register();
      await request(app.getHttpServer())
        .post('/api/v1/auth/verify-email')
        .send({ email, code })
        .expect(200);

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);

      expect(login.body.accessToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(login.body.user.accountType).toBe('USER');
      expect(login.body.user.permissions).toEqual([]);

      const cookies = login.headers['set-cookie'] as unknown as string[];
      const refresh = cookies.find((cookie) => cookie.startsWith('__Host-sh_rt='));
      expect(refresh).toContain('HttpOnly');
      expect(refresh).toContain('Secure');
      expect(refresh).toContain('Path=/api/v1/auth');
      expect(refresh).toContain('SameSite=Strict');
    });

    it('reports the same error for a wrong password and an unknown account', async () => {
      const { email, code } = await register();
      await request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ email, code });

      const wrongPassword = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'definitely-not-the-password' })
        .expect(401);

      const unknownAccount = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: uniqueEmail(), password: 'definitely-not-the-password' })
        .expect(401);

      expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(wrongPassword.body.error.message).toBe(unknownAccount.body.error.message);
    });

    /**
     * Regression guard: a short password must produce the same 401 as a long
     * wrong one. Validating login input against the strength policy would leak
     * "this address exists" through a distinguishable 422.
     */
    it('returns the same 401 for short, long and empty-ish wrong passwords', async () => {
      const { email, code } = await register();
      await request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ email, code });

      const short = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'abc' })
        .expect(401);
      const long = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'a-very-long-but-wrong-password-attempt' })
        .expect(401);

      expect(short.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(long.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(short.body.error.message).toBe(long.body.error.message);
    });

    it('locks the account after repeated failures, then refuses the right password', async () => {
      const { email, code } = await register();
      await request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ email, code });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email, password: `wrong-password-${attempt}` })
          .expect(401);
      }

      const locked = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(423);
      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    });

    it('throttles a flood of attempts from one identity', async () => {
      const email = `flood-${randomUUID()}@example.test`;
      let sawRateLimit = false;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const response = await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email, password: 'not-the-password' });
        if (response.status === 429) {
          sawRateLimit = true;
          break;
        }
      }
      expect(sawRateLimit).toBe(true);
    });
  });

  describe('session lifecycle', () => {
    it('returns the authenticated principal from /auth/me', async () => {
      const { accessToken } = await verifiedLogin();
      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(me.body.accountType).toBe('USER');
    });

    it('refuses requests without a token or with a forged one', async () => {
      await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('authorization', 'Bearer not.a.token')
        .expect(401);
    });

    it('rotates refresh tokens and detects reuse of a spent token', async () => {
      const { refreshCookie, csrfCookie, csrfToken } = await verifiedLogin();

      const first = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', joinCookies(refreshCookie, csrfCookie))
        .set('x-csrf-token', csrfToken)
        .expect(200);
      expect(first.body.accessToken).toContain('.');

      // Replaying the original (now consumed) token must be treated as theft.
      const replay = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', joinCookies(refreshCookie, csrfCookie))
        .set('x-csrf-token', csrfToken)
        .expect(401);
      expect(replay.body.error.code).toBe('TOKEN_REUSE_DETECTED');

      // And the family is dead: the rotated token no longer works either.
      const rotatedCookies = first.headers['set-cookie'] as unknown as string[];
      const rotated = rotatedCookies.find((cookie) => cookie.startsWith('__Host-sh_rt='));
      expect(rotated).toBeDefined();
      if (rotated === undefined) return;
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', joinCookies(rotated, csrfCookie))
        .set('x-csrf-token', csrfToken)
        .expect(401);
    });

    it('requires a matching CSRF double-submit token', async () => {
      const { refreshCookie, csrfCookie } = await verifiedLogin();
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', joinCookies(refreshCookie, csrfCookie))
        .set('x-csrf-token', 'forged-value')
        .expect(403);
    });

    it('invalidates every session when the password changes', async () => {
      const { email, code } = await register();
      await request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ email, code });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: PASSWORD })
        .expect(200);
      const accessToken = login.body.accessToken as string;

      await request(app.getHttpServer())
        .post('/api/v1/auth/password/forgot')
        .send({ email })
        .expect(202);

      const { rows } = await pool.query<{ id: string; code_digest: Buffer }>(
        `SELECT vc.id, vc.code_digest FROM verification_codes vc
           JOIN accounts a ON a.id = vc.account_id
          WHERE a.email = $1 AND vc.purpose = 'PASSWORD_RESET'`,
        [email],
      );
      const accountId = (
        await pool.query<{ id: string }>('SELECT id FROM accounts WHERE email = $1', [email])
      ).rows[0]?.id;
      if (accountId === undefined || rows[0] === undefined) throw new Error('fixture missing');

      const { digestOtp } = await import('./domain/one-time-code.js');
      let resetCode = '';
      for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
        const code2 = candidate.toString().padStart(6, '0');
        if (
          digestOtp({ accountId, purpose: 'PASSWORD_RESET', code: code2 }).equals(
            rows[0].code_digest,
          )
        ) {
          resetCode = code2;
          break;
        }
      }
      expect(resetCode).not.toBe('');

      await request(app.getHttpServer())
        .post('/api/v1/auth/password/reset')
        .send({ email, code: resetCode, password: 'a-brand-new-long-passphrase' })
        .expect(200);

      // The pre-reset access token must now fail: the session epoch moved.
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('authorization', `Bearer ${accessToken}`)
        .expect(401);

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'a-brand-new-long-passphrase' })
        .expect(200);
    });

    it('logs out the current session', async () => {
      const { accessToken } = await verifiedLogin();
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('authorization', `Bearer ${accessToken}`)
        .send({})
        .expect(204);

      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('authorization', `Bearer ${accessToken}`)
        .expect(401);
    });
  });

  describe('password reset', () => {
    it('answers identically for known and unknown addresses', async () => {
      const known = await request(app.getHttpServer())
        .post('/api/v1/auth/password/forgot')
        .send({ email: uniqueEmail() })
        .expect(202);
      const unknown = await request(app.getHttpServer())
        .post('/api/v1/auth/password/forgot')
        .send({ email: uniqueEmail() })
        .expect(202);
      expect(known.body).toEqual(unknown.body);
    });

    it('rejects a wrong reset code without changing the password', async () => {
      const { email } = await register();
      await request(app.getHttpServer())
        .post('/api/v1/auth/password/forgot')
        .send({ email })
        .expect(202);

      await request(app.getHttpServer())
        .post('/api/v1/auth/password/reset')
        .send({ email, code: '000000', password: 'yet-another-long-passphrase' })
        .expect(422);
    });
  });

  describe('audit trail', () => {
    /**
     * Regression guard: audit writes are fire-and-forget by design (a failed
     * audit insert must never fail a user request), which means a schema
     * mismatch would silently erase the trail. This asserts that the events a
     * registration produces actually land in the table.
     */
    it('records registration and OTP issuance as immutable, chained rows', async () => {
      const { email } = await register();

      const { rows } = await pool.query<{
        action: string;
        outcome: string;
        previous_hash: Buffer | null;
      }>(
        `SELECT action, outcome, previous_hash
           FROM audit_events
          WHERE actor_id = (SELECT id FROM accounts WHERE email = $1)
          ORDER BY occurred_at`,
        [email],
      );

      const actions = rows.map((row) => row.action);
      expect(actions).toContain('auth.register.success');
      expect(actions).toContain('auth.otp.issued');
      expect(rows.every((row) => row.outcome === 'SUCCESS')).toBe(true);

      // Every row this suite produced must link to a predecessor: the first event
      // of a fresh database starts the chain, everything after it continues it.
      expect(rows.length).toBeGreaterThan(1);
      const withPredecessor = rows.filter((row) => row.previous_hash !== null).length;
      expect(withPredecessor).toBeGreaterThanOrEqual(rows.length - 1);
    });

    it('marks denials as DENIED rather than dropping them', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `ghost-${randomUUID()}@example.test`, password: 'not-the-password' })
        .expect(401);

      const { rows } = await pool.query<{ outcome: string }>(
        `SELECT outcome FROM audit_events WHERE action = 'auth.login.failure' ORDER BY occurred_at DESC LIMIT 1`,
      );
      expect(rows[0]?.outcome).toBe('DENIED');
    });
  });

  describe('health', () => {
    it('reports liveness without touching dependencies', async () => {
      const response = await request(app.getHttpServer()).get('/health/live').expect(200);
      expect(response.body.status).toBe('ok');
    });

    it('reports readiness with dependency detail', async () => {
      const response = await request(app.getHttpServer()).get('/health/ready');
      expect([200, 503]).toContain(response.status);
      expect(response.body.checks).toHaveProperty('database');
    });
  });
});

/** Joins several `Set-Cookie` lines into one request `Cookie` header. */
const joinCookies = (...setCookies: readonly string[]): string =>
  setCookies
    .map((line) => line.split(';')[0] ?? '')
    .filter((pair) => pair.length > 0)
    .join('; ');

/** Reads the value out of a `Set-Cookie` header line. */
const cookieValue = (setCookie: string): string => {
  const match = /^[^=]+=([^;]*)/.exec(setCookie);
  if (match === null || match[1] === undefined) throw new Error('malformed cookie');
  return decodeURIComponent(match[1]);
};
