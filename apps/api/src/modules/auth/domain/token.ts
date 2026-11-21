/**
 * Token domain rules.
 *
 * Two token kinds, deliberately different in shape:
 *
 *   Access token  — short-lived, self-contained JWT, verified without I/O on
 *                   every request. Carries the account id, type, session id,
 *                   and the session epoch; never carries permissions (a mask
 *                   in a token cannot be revoked before it expires).
 *   Refresh token — long-lived, opaque, random, stored only as a digest,
 *                   rotated on every use, grouped into families so reuse of a
 *                   consumed token can be detected and the family revoked.
 */

import { createHash, randomBytes } from 'node:crypto';

export const ACCESS_TOKEN_AUDIENCE = 'socialhub-api';

export type AccessTokenClaims = {
  /** Issuer-minted subject: the account id. */
  readonly sub: string;
  readonly typ: 'access';
  readonly acc: 'USER' | 'STAFF' | 'ROOT';
  /** Session the token belongs to; revocation kills the whole session. */
  readonly sid: string;
  /** Session epoch at mint time; a credential change invalidates older tokens. */
  readonly epc: number;
  readonly iss: string;
  readonly aud: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
};

export type RefreshTokenMaterial = {
  /** The value handed to the client exactly once. Never stored. */
  readonly token: string;
  /** SHA-256 of the token, stored in the database. */
  readonly digest: Buffer;
};

const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Mints refresh material. base64url of 32 random bytes is 43 characters and
 * carries 256 bits of entropy — far beyond any feasible guessing attack, even
 * without a per-token rate limit.
 */
export const mintRefreshToken = (): RefreshTokenMaterial => {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { token, digest: digestRefreshToken(token) };
};

/**
 * Digest lookup key. A plain SHA-256 is correct here (unlike for passwords)
 * because the input already has full 256-bit entropy — there is nothing to
 * brute force, and a slow KDF would only add latency to every refresh.
 */
export const digestRefreshToken = (token: string): Buffer =>
  createHash('sha256').update(token, 'utf8').digest();

export const isWellFormedRefreshToken = (token: string): boolean =>
  REFRESH_TOKEN_PATTERN.test(token);

/** CSRF binding is enforced by the cookie policy; this is the client-facing name. */
export const REFRESH_COOKIE_NAME = '__Host-sh_rt';
export const CSRF_COOKIE_NAME = '__Host-sh_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export const REFRESH_COOKIE_PATH = '/api/v1/auth';
