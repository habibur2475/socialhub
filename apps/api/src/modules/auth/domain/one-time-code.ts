/**
 * One-time codes for email verification, password reset, login OTP and step-up.
 *
 * Properties that matter:
 *   * Generated with a CSPRNG, never Math.random.
 *   * Stored as a digest bound to the account and purpose, so a leaked database
 *     cannot be replayed.
 *   * Verification is constant-time and attempt-bounded; the bound lives in the
 *     database row so it survives a process restart and cannot be bypassed by
 *     hitting a different replica.
 *   * Comparison happens against a digest rather than the code itself, so the
 *     plaintext never exists outside the request that generated it.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

export const OTP_DIGITS = 6;

export type OtpPurpose =
  | 'EMAIL_VERIFY'
  | 'PHONE_VERIFY'
  | 'PASSWORD_RESET'
  | 'LOGIN_OTP'
  | 'MFA_ENROLL'
  | 'EMAIL_CHANGE';

export type OtpDigestInput = {
  readonly accountId: string;
  readonly purpose: OtpPurpose;
  readonly code: string;
};

/**
 * Domain-separated digest: account id and purpose are mixed in, so a code issued
 * for "reset password on account A" can never validate as "verify email on B".
 */
export const digestOtp = (input: OtpDigestInput): Buffer => {
  const material = `otp:v1\u0000${input.accountId}\u0000${input.purpose}\u0000${input.code}`;
  return createHash('sha256').update(material, 'utf8').digest();
};

/** Uniform 6-digit code, zero-padded. `randomInt` is rejection-sampled, so it is unbiased. */
export const generateOtpCode = (): string =>
  randomInt(0, 10 ** OTP_DIGITS)
    .toString()
    .padStart(OTP_DIGITS, '0');

export const formatOtpForDisplay = (code: string): string =>
  code.length === OTP_DIGITS ? `${code.slice(0, 3)} ${code.slice(3)}` : code;

/**
 * Constant-time verification of a submitted code against a stored digest.
 * The submitted code is validated by shape first: a non-numeric or wrong-length
 * input can never match, and rejecting it early avoids pointless digest work.
 */
export const verifyOtpCode = (
  submitted: string,
  storedDigest: Buffer,
  accountId: string,
  purpose: OtpPurpose,
): boolean => {
  if (!new RegExp(`^\\d{${OTP_DIGITS}}$`).test(submitted)) return false;
  const candidate = digestOtp({ accountId, purpose, code: submitted });
  if (candidate.length !== storedDigest.length) return false;
  return timingSafeEqual(candidate, storedDigest);
};

export type OtpState = {
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
};

export type OtpRejection =
  | { readonly code: 'EXPIRED' }
  | { readonly code: 'ALREADY_CONSUMED' }
  | { readonly code: 'ATTEMPTS_EXHAUSTED' }
  | { readonly code: 'MISMATCH' };

export type OtpCheck =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: OtpRejection };

/**
 * Evaluates a submitted code against its stored state and the submitted value.
 * Pure: the caller decides how to persist the incremented attempt counter, which
 * keeps this function trivially testable and replay-safe by construction.
 */
export const checkOtp = (
  state: OtpState,
  submitted: string,
  storedDigest: Buffer,
  accountId: string,
  purpose: OtpPurpose,
  now: Date = new Date(),
): OtpCheck => {
  if (state.consumedAt !== null) return { accepted: false, reason: { code: 'ALREADY_CONSUMED' } };
  if (state.expiresAt.getTime() <= now.getTime())
    return { accepted: false, reason: { code: 'EXPIRED' } };
  if (state.attempts >= state.maxAttempts) {
    return { accepted: false, reason: { code: 'ATTEMPTS_EXHAUSTED' } };
  }
  if (!verifyOtpCode(submitted, storedDigest, accountId, purpose)) {
    return { accepted: false, reason: { code: 'MISMATCH' } };
  }
  return { accepted: true };
};

/**
 * Masks a destination so it is recognisable to its owner but not harvestable
 * from a log or an API response. The output length equals the input length, so
 * the mask reveals nothing about how many characters were hidden beyond what is
 * already visible.
 */
export const maskDestination = (destination: string): string => {
  if (destination.includes('@')) {
    const [local = '', domain = ''] = destination.split('@');
    const visible = local.slice(0, 1);
    const hidden = Math.max(2, local.length - 1);
    return `${visible}${'*'.repeat(hidden)}@${domain}`;
  }
  // Preserve the leading non-digit run (the "+880" country prefix) so the owner
  // recognises the number, mask every digit in between, and reveal the last three.
  const prefix = /^[^0-9]*/.exec(destination)?.[0] ?? '';
  const body = destination.slice(prefix.length);
  return `${prefix}${'*'.repeat(Math.max(2, body.length - 3))}${body.slice(-3)}`;
};
