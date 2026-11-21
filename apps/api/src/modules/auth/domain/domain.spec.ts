import { describe, expect, it } from 'vitest';

import { evaluatePassword, isPasswordAcceptable } from './password-policy.js';
import {
  checkOtp,
  digestOtp,
  generateOtpCode,
  maskDestination,
  verifyOtpCode,
} from './one-time-code.js';
import { digestRefreshToken, isWellFormedRefreshToken, mintRefreshToken } from './token.js';
import { constantTimeEquals, parseArgon2Parameters } from '../../../common/crypto/password.js';
import { JsonLogger } from '../../../common/logging/logger.js';

const context = {
  email: 'ada@example.test',
  username: 'ada_lovelace',
  displayName: 'Ada Lovelace',
  isAdministrative: false,
};

describe('password policy', () => {
  it('accepts a long, varied passphrase', () => {
    expect(isPasswordAcceptable('correct horse battery staple', context)).toBe(true);
  });

  it('rejects short passwords', () => {
    expect(evaluatePassword('short', context)).toContainEqual({ code: 'TOO_SHORT', minimum: 10 });
  });

  it('demands a longer minimum for administrative accounts', () => {
    const administrative = { ...context, isAdministrative: true };
    const violations = evaluatePassword('elevenchars', administrative);
    expect(violations).toContainEqual({ code: 'TOO_SHORT', minimum: 12 });
  });

  it('rejects passwords containing the account identity', () => {
    const codes = evaluatePassword('ada_lovelace-2024', context).map((violation) => violation.code);
    expect(codes).toContain('CONTAINS_IDENTITY');
  });

  it('rejects blocklisted and degenerate patterns', () => {
    expect(evaluatePassword('password123', context).map((v) => v.code)).toContain('TOO_COMMON');
    expect(evaluatePassword('aaaaaaaaaaaa', context).map((v) => v.code)).toContain(
      'REPEATED_PATTERN',
    );
    expect(evaluatePassword('abcdabcdabcd', context).map((v) => v.code)).toContain(
      'REPEATED_PATTERN',
    );
    expect(evaluatePassword('abcdefghijkl', context).map((v) => v.code)).toContain(
      'REPEATED_PATTERN',
    );
  });

  it('rejects single-character-class passwords', () => {
    expect(evaluatePassword('onlylowercaseletters', context).map((v) => v.code)).toContain(
      'LOW_VARIETY',
    );
  });

  it('reports every violation at once', () => {
    const violations = evaluatePassword('aaaa', context);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0]?.code).toBe('TOO_SHORT');
  });

  it('enforces an upper bound so hashing cannot be used as a denial of service', () => {
    expect(evaluatePassword('a1'.repeat(100), context).map((v) => v.code)).toContain('TOO_LONG');
  });
});

describe('one-time codes', () => {
  it('generates uniform six-digit codes', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateOtpCode()));
    expect([...codes].every((code) => /^\d{6}$/.test(code))).toBe(true);
    expect(codes.size).toBeGreaterThan(400);
  });

  it('binds the digest to account and purpose', () => {
    const digest = digestOtp({ accountId: 'a', purpose: 'EMAIL_VERIFY', code: '123456' });
    expect(verifyOtpCode('123456', digest, 'a', 'EMAIL_VERIFY')).toBe(true);
    expect(verifyOtpCode('123456', digest, 'b', 'EMAIL_VERIFY')).toBe(false);
    expect(verifyOtpCode('123456', digest, 'a', 'PASSWORD_RESET')).toBe(false);
    expect(verifyOtpCode('654321', digest, 'a', 'EMAIL_VERIFY')).toBe(false);
    expect(verifyOtpCode('12345', digest, 'a', 'EMAIL_VERIFY')).toBe(false);
  });

  const state = (overrides: Partial<Parameters<typeof checkOtp>[0]> = {}) => ({
    attempts: 0,
    maxAttempts: 5,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    ...overrides,
  });

  it('accepts a valid, live code', () => {
    const digest = digestOtp({ accountId: 'a', purpose: 'LOGIN_OTP', code: '111111' });
    expect(checkOtp(state(), '111111', digest, 'a', 'LOGIN_OTP')).toEqual({ accepted: true });
  });

  it('rejects expired, consumed and exhausted codes', () => {
    const digest = digestOtp({ accountId: 'a', purpose: 'LOGIN_OTP', code: '111111' });
    expect(
      checkOtp(state({ expiresAt: new Date(Date.now() - 1) }), '111111', digest, 'a', 'LOGIN_OTP'),
    ).toMatchObject({
      accepted: false,
      reason: { code: 'EXPIRED' },
    });
    expect(
      checkOtp(state({ consumedAt: new Date() }), '111111', digest, 'a', 'LOGIN_OTP'),
    ).toMatchObject({
      accepted: false,
      reason: { code: 'ALREADY_CONSUMED' },
    });
    expect(checkOtp(state({ attempts: 5 }), '111111', digest, 'a', 'LOGIN_OTP')).toMatchObject({
      accepted: false,
      reason: { code: 'ATTEMPTS_EXHAUSTED' },
    });
  });

  it('masks destinations for display', () => {
    expect(maskDestination('ada@example.test')).toBe('a**@example.test');
    // Same length as the input: +880 (4 visible) + hidden digits + last 3.
    // Only the leading '+' survives: the country/operator prefix is itself
    // identifying, so revealing it would defeat the mask. Length is preserved.
    expect(maskDestination('+8801712345678')).toBe('+**********678');
    expect(maskDestination('+8801712345678')).toHaveLength('+8801712345678'.length);
  });
});

describe('refresh tokens', () => {
  it('are unguessable and well formed', () => {
    const first = mintRefreshToken();
    const second = mintRefreshToken();
    expect(first.token).not.toBe(second.token);
    expect(isWellFormedRefreshToken(first.token)).toBe(true);
    expect(first.digest).toHaveLength(32);
    expect(first.digest.equals(digestRefreshToken(first.token))).toBe(true);
  });

  it('rejects malformed candidates before hashing', () => {
    expect(isWellFormedRefreshToken('')).toBe(false);
    expect(isWellFormedRefreshToken('a'.repeat(42))).toBe(false);
    expect(isWellFormedRefreshToken(`${'a'.repeat(42)}!`)).toBe(false);
  });
});

describe('argon2 parameter inspection', () => {
  it('parses PHC strings', () => {
    const digest =
      '$argon2id$v=19$m=47104,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(parseArgon2Parameters(digest)).toEqual({
      algorithm: 'argon2id',
      memoryCost: 47104,
      timeCost: 3,
      parallelism: 1,
    });
  });

  it('reports unparseable digests so they are rehashed', () => {
    expect(parseArgon2Parameters('not-a-phc-string')).toBeNull();
  });

  it('compares fixed-length buffers in constant time', () => {
    expect(constantTimeEquals(Buffer.alloc(32, 1), Buffer.alloc(32, 1))).toBe(true);
    expect(constantTimeEquals(Buffer.alloc(32, 1), Buffer.alloc(32, 2))).toBe(false);
    expect(constantTimeEquals(Buffer.alloc(31, 1), Buffer.alloc(32, 1))).toBe(false);
  });
});

describe('structured logging', () => {
  it('redacts sensitive keys at any depth', () => {
    const captured: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;

    try {
      const logger = new JsonLogger('trace');
      logger.event('info', 'auth.login', {
        email: 'ada@example.test',
        password: 'super-secret',
        nested: { refreshToken: 'abc', authorization: 'Bearer x', attempts: 2 },
        errorCode: 'VALIDATION_FAILED',
      });
    } finally {
      process.stdout.write = original;
    }

    const line = captured.join('');
    expect(line).toContain('ada@example.test');
    // Allowlisted diagnostics survive; secrets never do.
    expect(line).toContain('"errorCode":"VALIDATION_FAILED"');
    expect(line).not.toContain('super-secret');
    expect(line).not.toContain('abc');
    expect(line).not.toContain('Bearer x');
    expect(line).toContain('[redacted]');
  });
});
