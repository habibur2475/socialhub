/**
 * Password policy.
 *
 * Length is the dominant factor in password strength, so the rules demand a
 * minimum of 10 (with a 12-character floor for administrative accounts) and
 * allow long passphrases up to 128. Character-class mandates are deliberately
 * absent: they push users toward predictable shapes ("Password1!") without
 * measurably improving entropy. Instead we reject the two things that actually
 * help an attacker — a blocklist of common passwords and repetition/sequence
 * patterns — and require the password not to contain the user's own identity.
 */

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../../common/crypto/password.js';

export type PasswordViolation =
  | { readonly code: 'TOO_SHORT'; readonly minimum: number }
  | { readonly code: 'TOO_LONG'; readonly maximum: number }
  | { readonly code: 'TOO_COMMON' }
  | { readonly code: 'LOW_VARIETY' }
  | { readonly code: 'CONTAINS_IDENTITY'; readonly field: 'email' | 'username' | 'displayName' }
  | { readonly code: 'REPEATED_PATTERN' };

/**
 * A compact blocklist of the passwords that dominate credential-stuffing lists.
 * In production this set is loaded from a versioned file; the interface is the
 * same, so the swap is a one-line adapter change.
 */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '1234567890',
  '12345678910',
  'qwertyuiop',
  'qwerty12345',
  'password123',
  'password1234',
  'password12345',
  'iloveyou123',
  'admin12345',
  'welcome1234',
  'letmein1234',
  'abcd1234567',
  'socialhub123',
  'changeme123',
  'football123',
  'baseball123',
  'sunshine123',
  'princess123',
  'superman123',
  'starwars123',
  'trustno1mkc',
  'passw0rd123',
  'p@ssw0rd123',
]);

export const ADMIN_MIN_PASSWORD_LENGTH = 12;

export type PasswordContext = {
  readonly email?: string;
  readonly username?: string;
  readonly displayName?: string;
  readonly isAdministrative: boolean;
};

type IdentityField = 'email' | 'username' | 'displayName';
type IdentityToken = { readonly field: IdentityField; readonly value: string };

const identityTokens = (context: PasswordContext): readonly IdentityToken[] => {
  const entries: IdentityToken[] = [];
  if (context.email !== undefined) {
    const local = context.email.split('@')[0];
    if (local !== undefined && local.length >= 3) entries.push({ field: 'email', value: local });
  }
  if (context.username !== undefined && context.username.length >= 3) {
    entries.push({ field: 'username', value: context.username });
  }
  if (context.displayName !== undefined) {
    for (const part of context.displayName.split(/\s+/)) {
      if (part.length >= 3) entries.push({ field: 'displayName', value: part });
    }
  }
  return entries;
};

/** Detects "aaaaaa", "ababab", "123123123" and monotone runs like "abcdefghij". */
const hasDegeneratePattern = (password: string): boolean => {
  const lower = password.toLowerCase();

  if (/(.)\1{3,}/u.test(lower)) return true;

  for (let size = 2; size <= 4; size += 1) {
    const unit = lower.slice(0, size);
    if (
      unit.length === size &&
      unit.repeat(Math.ceil(lower.length / size)).slice(0, lower.length) === lower
    ) {
      return true;
    }
  }

  const isMonotone = (direction: 1 | -1): boolean => {
    for (let index = 1; index < lower.length; index += 1) {
      const previous = lower.charCodeAt(index - 1);
      const current = lower.charCodeAt(index);
      if (current - previous !== direction) return false;
    }
    return true;
  };
  if (lower.length >= 6 && (isMonotone(1) || isMonotone(-1))) return true;

  return false;
};

const distinctClasses = (password: string): number => {
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/\d/.test(password)) classes += 1;
  if (/[^A-Za-z0-9]/.test(password)) classes += 1;
  return classes;
};

/**
 * Returns every violation found, so a registration form can show all problems
 * at once rather than one per submit. An empty array means the password passes.
 */
export const evaluatePassword = (
  password: string,
  context: PasswordContext,
): readonly PasswordViolation[] => {
  const violations: PasswordViolation[] = [];
  const minimum = context.isAdministrative
    ? Math.max(MIN_PASSWORD_LENGTH, ADMIN_MIN_PASSWORD_LENGTH)
    : MIN_PASSWORD_LENGTH;

  if (password.length < minimum) violations.push({ code: 'TOO_SHORT', minimum });
  if (password.length > MAX_PASSWORD_LENGTH)
    violations.push({ code: 'TOO_LONG', maximum: MAX_PASSWORD_LENGTH });

  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) violations.push({ code: 'TOO_COMMON' });

  if (password.length >= minimum) {
    if (distinctClasses(password) < 2) violations.push({ code: 'LOW_VARIETY' });
    if (hasDegeneratePattern(password)) violations.push({ code: 'REPEATED_PATTERN' });

    for (const identity of identityTokens(context)) {
      if (lower.includes(identity.value.toLowerCase())) {
        violations.push({ code: 'CONTAINS_IDENTITY', field: identity.field });
        break;
      }
    }
  }

  return violations;
};

export const isPasswordAcceptable = (password: string, context: PasswordContext): boolean =>
  evaluatePassword(password, context).length === 0;
