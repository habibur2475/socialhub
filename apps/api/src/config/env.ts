/**
 * Environment schema.
 *
 * Parsed once at boot with zod, then frozen. Nothing in the application reads
 * `process.env` directly: a missing or malformed variable must fail the process
 * at startup, not the first request that happens to need it. Secrets are never
 * logged and never echoed in error messages.
 */

import { z } from 'zod';

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const port = z.coerce.number().int().min(1).max(65_535);

const duration = (milliseconds: number) => z.coerce.number().int().positive().default(milliseconds);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().min(1).default('socialhub-api'),
  PORT: port.default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),

  // Postgres: shard map resolution happens in the shard router, so the API holds
  // a per-shard pool set rather than a single connection.
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
  DATABASE_SSL: booleanish.default('false'),

  // Redis: permission cache, rate limits, audit chain head. Required in every
  // deployed environment; CACHE_DRIVER=memory is a development/test escape hatch
  // and is refused in production by the cache provider.
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  // `memory` is a development/test escape hatch; the cache provider refuses it
  // in production because a per-process cache breaks cross-replica correctness.
  CACHE_DRIVER: z.enum(['redis', 'memory']).default('memory'),

  // Token signing. The secret must be at least 32 bytes of entropy; the key id
  // allows zero-downtime rotation with two valid keys during the overlap window.
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: duration(15 * 60),
  JWT_REFRESH_TTL_SECONDS: duration(30 * 24 * 60 * 60),
  JWT_ISSUER: z.string().min(1).default('socialhub'),
  JWT_AUDIENCE: z.string().min(1).default('socialhub-api'),

  // Credential hashing. Memory cost is deliberately explicit: OWASP minimum is
  // 19 MiB for Argon2id, and we use 46 MiB with parallelism 1.
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(19_456).default(47_104),
  ARGON2_TIME_COST: z.coerce.number().int().min(2).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(8).default(1),

  // Brute-force defence.
  MAX_FAILED_LOGINS: z.coerce.number().int().min(3).default(5),
  LOCKOUT_SECONDS: duration(15 * 60),
  OTP_TTL_SECONDS: duration(10 * 60),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),

  // Transport security.
  TRUST_PROXY: booleanish.default('true'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),

  // Mail (development: log transport; production: SES/SMTP via adapter).
  MAIL_FROM: z.string().default('SocialHub <no-reply@socialhub.local>'),
  MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  SENTRY_DSN: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates. Throws a message that names the offending variables and
 * their problems, but never their values.
 */
export const parseEnv = (source: NodeJS.ProcessEnv): Env => {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }
  return Object.freeze(result.data);
};
