import { describe, expect, it } from 'vitest';

import {
  DISPLAY_NAME_PATTERN,
  loginRequestSchema,
  registerRequestSchema,
  resetPasswordRequestSchema,
} from './auth.js';
import { validationIssuesOf, type ApiErrorBody } from './responses.js';

const valid = {
  email: 'Ada@Example.test',
  password: 'correct-horse-battery',
  username: 'ada_lovelace',
  displayName: 'Ada Lovelace',
};

describe('request contracts', () => {
  it('normalises email once, on the way in', () => {
    const parsed = registerRequestSchema.parse(valid);
    expect(parsed.email).toBe('ada@example.test');
  });

  it('lowercases usernames so they cannot shadow one another', () => {
    expect(registerRequestSchema.parse({ ...valid, username: 'ADA_LOVELACE' }).username).toBe(
      'ada_lovelace',
    );
  });

  it('rejects unknown keys instead of silently dropping them', () => {
    const result = registerRequestSchema.safeParse({ ...valid, accountType: 'ROOT' });
    expect(result.success).toBe(false);
  });

  it('accepts display names in any script', () => {
    expect(DISPLAY_NAME_PATTERN.test('মেহেদী হাসান')).toBe(true);
    expect(DISPLAY_NAME_PATTERN.test('Jean-Luc O’Brien')).toBe(false);
  });

  // The apostrophe in the test above is a typographic one, which the pattern
  // deliberately rejects: an ASCII apostrophe is what a keyboard produces.
  it('accepts an ASCII apostrophe and period in display names', () => {
    expect(DISPLAY_NAME_PATTERN.test("Jean-Luc O'Brien Jr.")).toBe(true);
  });

  it('rejects a display name that starts with punctuation', () => {
    expect(DISPLAY_NAME_PATTERN.test('.hidden')).toBe(false);
  });

  it('applies the strength policy when a password is chosen', () => {
    expect(
      resetPasswordRequestSchema.safeParse({
        email: 'a@b.test',
        code: '123456',
        password: 'short',
      }).success,
    ).toBe(false);
  });

  /**
   * Regression guard for an account-existence oracle: login must accept a short
   * password so the server can answer with the same 401 as any other wrong guess.
   */
  it('does not apply the strength policy to login', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.test', password: 'abc' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ email: 'a@b.test', password: '' }).success).toBe(false);
  });
});

describe('validation error narrowing', () => {
  it('extracts field paths and messages from details', () => {
    const body: ApiErrorBody = {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        traceId: 'trace-1234',
        details: {
          issues: [
            { path: 'email', message: 'Enter a valid email address' },
            { path: 'password', message: 'Password must be at least 10 characters' },
          ],
        },
      },
    };

    expect(validationIssuesOf(body)).toEqual([
      { path: 'email', message: 'Enter a valid email address' },
      { path: 'password', message: 'Password must be at least 10 characters' },
    ]);
  });

  it('returns an empty list when the payload is not what it claims to be', () => {
    const body = {
      error: { code: 'INTERNAL_ERROR', message: 'x', traceId: 't', details: { issues: 'nope' } },
    } as unknown as ApiErrorBody;

    expect(validationIssuesOf(body)).toEqual([]);
  });
});
