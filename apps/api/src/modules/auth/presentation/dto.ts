/**
 * Request schemas.
 *
 * The schemas themselves live in `@socialhub/contracts` because the browser needs
 * the identical rules for its own form validation. Re-declaring them here would
 * let the two drift, and a browser that accepts input the API rejects is a bug
 * users experience as broken.
 *
 * This module exists only to re-export the request types under the names the
 * controller uses, and to declare the response types the controller promises —
 * which are checked against the shared contracts with `satisfies`.
 *
 * Validation is applied by a pipe that does not depend on `design:paramtypes`
 * metadata. That is deliberate: decorator metadata is emitted by `tsc` but not by
 * esbuild/tsx/vitest, so a metadata-validated DTO is validated in production and
 * silently skipped in tests. Explicit schemas cannot be skipped.
 */

export {
  registerRequestSchema as registerSchema,
  loginRequestSchema as loginSchema,
  verifyEmailRequestSchema as verifyEmailSchema,
  requestPasswordResetRequestSchema as requestPasswordResetSchema,
  resetPasswordRequestSchema as resetPasswordSchema,
  refreshRequestSchema as refreshSchema,
  logoutRequestSchema as logoutSchema,
} from '@socialhub/contracts';

export type {
  RegisterRequest as RegisterDto,
  LoginRequest as LoginDto,
  VerifyEmailRequest as VerifyEmailDto,
  RequestPasswordResetRequest as RequestPasswordResetDto,
  ResetPasswordRequest as ResetPasswordDto,
  RefreshRequest as RefreshDto,
  LogoutRequest as LogoutDto,
  RegisteredResponse as RegisteredResponseDto,
  SessionResponse as SessionResponseDto,
  CurrentUserResponse as CurrentUserResponseDto,
  VerifyEmailResponse as VerifyEmailResponseDto,
  MessageResponse as MessageResponseDto,
} from '@socialhub/contracts';
