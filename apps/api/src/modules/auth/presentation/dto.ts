/**
 * Request schemas.
 *
 * Validation is declared as explicit zod schemas and applied by a pipe that does
 * not depend on `design:paramtypes` metadata. That is a deliberate choice:
 *
 *   * Decorator metadata is a build-tool feature. It is emitted by `tsc` but not
 *     by esbuild/tsx/vitest transforms, so a class-validator DTO validated in
 *     production and silently skipped in tests is a real failure mode — and the
 *     one that bit this codebase.
 *   * The schema is also a type: `z.infer` removes any possibility of the DTO and
 *     the declared parameter type drifting apart.
 *   * Unknown keys are rejected (`.strict()`), which closes parameter smuggling
 *     such as posting `accountType: "ROOT"` to a registration endpoint.
 */

import { z } from 'zod';

export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_MIN_LENGTH = 10;
export const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;
/** Letters (any script), marks, spaces, apostrophe, period, hyphen. */
export const DISPLAY_NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\s'.-]{0,79}$/u;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH, 'Email address is too long')
  .email('Enter a valid email address');

const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

const otpCode = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const registerSchema = z
  .object({
    email,
    password,
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        USERNAME_PATTERN,
        'Username must be 3-30 characters: lowercase letters, digits or underscore',
      ),
    displayName: z
      .string()
      .trim()
      .regex(DISPLAY_NAME_PATTERN, 'Display name contains unsupported characters'),
  })
  .strict();

export const loginSchema = z.object({ email, password }).strict();

export const verifyEmailSchema = z.object({ email, code: otpCode }).strict();

export const requestPasswordResetSchema = z.object({ email }).strict();

export const resetPasswordSchema = z.object({ email, code: otpCode, password }).strict();

/**
 * Browsers send the refresh token as an HttpOnly cookie and therefore post an
 * empty body. `undefined` is normalised to `{}` so the schema can stay strict
 * about unknown keys without rejecting a legitimate empty POST.
 */
export const refreshSchema = z.preprocess(
  (value) => value ?? {},
  z
    .object({
      /**
       * Optional: only non-browser clients that cannot use cookies need to send
       * the token in the body.
       */
      refreshToken: z.string().length(43, 'Malformed refresh token').optional(),
    })
    .strict(),
);

export const logoutSchema = z.object({ scope: z.enum(['current', 'all']).optional() }).strict();

export type RegisterDto = z.infer<typeof registerSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
export type VerifyEmailDto = z.infer<typeof verifyEmailSchema>;
export type RequestPasswordResetDto = z.infer<typeof requestPasswordResetSchema>;
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;
export type RefreshDto = z.infer<typeof refreshSchema>;
export type LogoutDto = z.infer<typeof logoutSchema>;

export type AuthUserDto = {
  readonly id: string;
  readonly accountType: 'USER' | 'STAFF' | 'ROOT';
  readonly permissions: readonly string[];
};

export type SessionResponseDto = {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
  readonly user: AuthUserDto;
};

export type RegisteredResponseDto = {
  readonly verificationRequired: boolean;
  readonly message: string;
};
