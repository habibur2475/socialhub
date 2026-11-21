import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
};

const withOverrides = (overrides: Record<string, string>): NodeJS.ProcessEnv => ({
  ...base,
  ...overrides,
});

describe('environment configuration', () => {
  it('accepts the default development configuration', () => {
    const env = parseEnv(withOverrides({}));
    expect(env.NODE_ENV).toBe('development');
    expect(env.ARGON2_MEMORY_KIB).toBeGreaterThanOrEqual(19_456);
  });

  it('names every offending variable without revealing any value', () => {
    const env = withOverrides({ JWT_ACCESS_SECRET: 'too-short', DATABASE_URL: 'nope' });
    let message = '';
    try {
      parseEnv(env);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain('too-short');
    expect(message).not.toContain('nope');
  });

  /**
   * The log transport writes message bodies — including one-time codes — to the
   * log stream. Deploying it would leak every credential the system issues.
   */
  it('refuses the log mail transport in production', () => {
    expect(() =>
      parseEnv(withOverrides({ NODE_ENV: 'production', MAIL_TRANSPORT: 'log' })),
    ).toThrow(/MAIL_TRANSPORT/);
  });

  it('permits the log transport in development and the smtp transport in production', () => {
    expect(
      parseEnv(withOverrides({ NODE_ENV: 'development', MAIL_TRANSPORT: 'log' })).MAIL_TRANSPORT,
    ).toBe('log');
    expect(
      parseEnv(withOverrides({ NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp' })).MAIL_TRANSPORT,
    ).toBe('smtp');
  });

  it('parses CORS origins into a trimmed, non-empty list', () => {
    const env = parseEnv(withOverrides({ CORS_ORIGINS: ' https://a.test ,, https://b.test ' }));
    expect(env.CORS_ORIGINS).toEqual(['https://a.test', 'https://b.test']);
  });

  it('rejects an access token lifetime that is not a positive integer', () => {
    expect(() => parseEnv(withOverrides({ JWT_ACCESS_TTL_SECONDS: '0' }))).toThrow(
      /JWT_ACCESS_TTL_SECONDS/,
    );
  });
});
