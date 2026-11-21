/**
 * Request contracts for the public API.
 *
 * This module is the single definition of what the API accepts and returns. The
 * server validates with these schemas and the browser client builds requests with
 * the same objects, so the two cannot drift: a field renamed here breaks both
 * sides at compile time instead of at runtime in production.
 *
 * Why zod rather than hand-written types plus separate validation: a type is
 * erased, a schema is not. One artefact serves as the runtime validator, the
 * static type, and the form-level validator in the browser.
 *
 * Clients must never re-implement these rules. If the browser enforced a
 * different minimum length than the server, users would see a form accept a
 * password the API then rejects — the schema is exported precisely to prevent it.
 */

import { z } from 'zod';

export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_MIN_LENGTH = 10;
export const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;
/** Letters (any script), marks, spaces, apostrophe, period, hyphen. */
export const DISPLAY_NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}\s'.-]{0,79}$/u;

/**
 * Email is trimmed and lowercased before validation, so `Ada@Example.test` and
 * `ada@example.test` are the same account. Normalising on the way in rather than
 * on the way out means an unnormalised value can never reach the database.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH, 'Email address is too long')
  .email('Enter a valid email address');

/** The strength policy for password *creation* (register, reset). */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

/**
 * Login accepts any non-empty password.
 *
 * The strength policy belongs to the two places a password is *chosen*.
 * Applying a minimum here would reject a legitimate account whose password
 * predates a policy change, and would answer wrong short guesses with a
 * distinguishable 422 — an oracle for "this address exists".
 */
export const loginPasswordSchema = z
  .string()
  .min(1, 'Password is required')
  .max(PASSWORD_MAX_LENGTH);

export const otpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: newPasswordSchema,
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

export const loginRequestSchema = z
  .object({ email: emailSchema, password: loginPasswordSchema })
  .strict();

export const verifyEmailRequestSchema = z
  .object({ email: emailSchema, code: otpCodeSchema })
  .strict();

export const requestPasswordResetRequestSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordRequestSchema = z
  .object({ email: emailSchema, code: otpCodeSchema, password: newPasswordSchema })
  .strict();

/** Refresh posts no body from a browser; `undefined` normalises to `{}`. */
export const refreshRequestSchema = z.preprocess(
  (value) => value ?? {},
  z
    .object({
      /** Only for non-browser clients that cannot hold cookies. */
      refreshToken: z.string().length(43, 'Malformed refresh token').optional(),
    })
    .strict(),
);

export const logoutRequestSchema = z
  .object({ scope: z.enum(['current', 'all']).optional() })
  .strict();

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;
export type RequestPasswordResetRequest = z.infer<typeof requestPasswordResetRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type LogoutRequest = z.infer<typeof logoutRequestSchema>;
