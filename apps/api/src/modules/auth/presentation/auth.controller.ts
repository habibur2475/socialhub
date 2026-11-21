/**
 * HTTP surface for authentication.
 *
 * The controller does four things and nothing else: read cookies, build the
 * request context, call one use case, and shape the response. All policy lives
 * in `AuthService`.
 *
 * Cookie strategy (`__Host-` prefix requires Secure + Path=/ + no Domain):
 *   __Host-sh_rt     HttpOnly refresh token. JavaScript cannot read it, so XSS
 *                    cannot exfiltrate a long-lived credential.
 *   __Host-sh_csrf   Readable CSRF token. Double-submit: the client echoes it in
 *                    a header, and because a cross-site request cannot read the
 *                    cookie, it cannot produce the matching header.
 * The access token is returned in the body and held in memory by the client —
 * never in localStorage, where any script on the page could read it.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { appError } from '@socialhub/kernel';

import { DomainException } from '../../../common/filters/domain-exception.js';
import { CurrentPrincipal } from '../../../common/decorators/current-principal.decorator.js';
import type { Env } from '../../../config/env.js';
import { createFingerprints } from '../../../common/crypto/hashing.js';
import type { AuthService, RequestContext, SessionTokens } from '../application/auth.service.js';
import { PermissionCache } from '../infrastructure/permission-cache.js';
import { AUTH_SERVICE } from '../auth.tokens.js';
import { ENV } from '../../../config/config.module.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
} from '../domain/token.js';
import { AuthGuard, type AuthenticatedPrincipal } from './auth.guard.js';
import {
  type LoginDto,
  type LogoutDto,
  type RefreshDto,
  type RegisterDto,
  type RegisteredResponseDto,
  type RequestPasswordResetDto,
  type ResetPasswordDto,
  type SessionResponseDto,
  type VerifyEmailDto,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './dto.js';
import { ZodBody } from '../../../common/pipes/zod-validation.pipe.js';

const CSRF_TOKEN_BYTES = 32;

@Controller('auth')
export class AuthController {
  private readonly fingerprints;

  public constructor(
    @Inject(AUTH_SERVICE) private readonly auth: AuthService,
    @Inject(PermissionCache) private readonly permissions: PermissionCache,
    @Inject(ENV) private readonly env: Env,
  ) {
    // The pepper is derived from the refresh secret, which is already a required
    // 32-byte secret; this avoids introducing a second key that could drift.
    this.fingerprints = createFingerprints(env.JWT_REFRESH_SECRET);
  }

  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  public async register(
    @Body(new ZodBody(registerSchema)) body: RegisterDto,
    @Req() request: Request,
  ): Promise<RegisteredResponseDto> {
    const result = await this.auth.register({
      email: body.email,
      password: body.password,
      username: body.username,
      displayName: body.displayName,
      context: this.contextOf(request),
    });

    if (!result.ok) throw new DomainException(result.error);

    return {
      verificationRequired: result.value.verificationRequired,
      message: 'Check your inbox for a 6-digit verification code.',
    };
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  public async verifyEmail(
    @Body(new ZodBody(verifyEmailSchema)) body: VerifyEmailDto,
    @Req() request: Request,
  ): Promise<{ activated: boolean }> {
    const result = await this.auth.verifyEmail({
      email: body.email,
      code: body.code,
      context: this.contextOf(request),
    });
    if (!result.ok) throw new DomainException(result.error);
    return result.value;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  public async login(
    @Body(new ZodBody(loginSchema)) body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponseDto> {
    const result = await this.auth.login({
      email: body.email,
      password: body.password,
      context: this.contextOf(request),
    });
    if (!result.ok) throw new DomainException(result.error);

    this.setSessionCookies(response, result.value.session);

    return this.toSessionResponse(
      result.value.session,
      result.value.accountId,
      result.value.accountType,
      result.value.permissions,
    );
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  public async refresh(
    @Body(new ZodBody(refreshSchema)) body: RefreshDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionResponseDto> {
    this.assertCsrf(request);

    const cookieToken = readCookie(request, REFRESH_COOKIE_NAME);
    const token = body.refreshToken ?? cookieToken;
    if (token === undefined) {
      throw new DomainException(appError('SESSION_EXPIRED', 'No session to refresh'));
    }

    const result = await this.auth.refresh({
      refreshToken: token,
      context: this.contextOf(request),
    });
    if (!result.ok) {
      this.clearSessionCookies(response);
      throw new DomainException(result.error);
    }

    this.setSessionCookies(response, result.value.session);

    return this.toSessionResponse(
      result.value.session,
      result.value.accountId,
      result.value.accountType,
      result.value.permissions,
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard)
  public async logout(
    @Body(new ZodBody(logoutSchema)) body: LogoutDto,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    if (body.scope === 'all') {
      await this.auth.logoutAll(principal.accountId, this.contextOf(request));
    } else {
      await this.auth.logout(principal.sessionId, this.contextOf(request));
    }
    await this.permissions.invalidate(principal.accountId);
    this.clearSessionCookies(response);
  }

  @Get('me')
  @UseGuards(AuthGuard)
  public async me(@CurrentPrincipal() principal: AuthenticatedPrincipal): Promise<{
    id: string;
    accountType: string;
    permissions: readonly string[];
  }> {
    const resolved = await this.permissions.resolve(principal.accountId);
    return {
      id: principal.accountId,
      accountType: principal.accountType,
      permissions: resolved.mask.toList(),
    };
  }

  @Post('password/forgot')
  @HttpCode(HttpStatus.ACCEPTED)
  public async forgotPassword(
    @Body(new ZodBody(requestPasswordResetSchema)) body: RequestPasswordResetDto,
    @Req() request: Request,
  ): Promise<{ message: string }> {
    await this.auth.requestPasswordReset(body.email, this.contextOf(request));
    // Constant response regardless of account existence.
    return { message: 'If an account exists for that address, a code is on its way.' };
  }

  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  public async resetPassword(
    @Body(new ZodBody(resetPasswordSchema)) body: ResetPasswordDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ message: string }> {
    const result = await this.auth.resetPassword({
      email: body.email,
      code: body.code,
      password: body.password,
      context: this.contextOf(request),
    });
    if (!result.ok) throw new DomainException(result.error);
    this.clearSessionCookies(response);
    return { message: 'Password updated. Please sign in with your new password.' };
  }

  private toSessionResponse(
    session: SessionTokens,
    accountId: string,
    accountType: 'USER' | 'STAFF' | 'ROOT',
    permissions: readonly string[],
  ): SessionResponseDto {
    return {
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      refreshTokenExpiresAt: session.refreshTokenExpiresAt.toISOString(),
      user: { id: accountId, accountType, permissions },
    };
  }

  private setSessionCookies(response: Response, session: SessionTokens): void {
    const secure = this.env.NODE_ENV !== 'development';
    const sameSite: 'strict' = 'strict';

    response.cookie(REFRESH_COOKIE_NAME, session.refreshToken, {
      httpOnly: true,
      secure,
      sameSite,
      path: REFRESH_COOKIE_PATH,
      expires: session.refreshTokenExpiresAt,
    });

    // Double-submit token: readable by our own origin, useless to a cross-site
    // attacker because cookies are not readable across origins.
    response.cookie(CSRF_COOKIE_NAME, randomBytes(CSRF_TOKEN_BYTES).toString('base64url'), {
      httpOnly: false,
      secure,
      sameSite,
      path: '/',
      expires: session.refreshTokenExpiresAt,
    });
  }

  private clearSessionCookies(response: Response): void {
    response.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
    response.clearCookie(CSRF_COOKIE_NAME, { path: '/' });
  }

  /**
   * Double-submit verification. Both values must be present and identical.
   * A missing CSRF cookie is treated as a failure: a browser that has cookies
   * disabled still receives one on login, so absence means the request did not
   * originate from our origin.
   */
  private assertCsrf(request: Request): void {
    const cookie = readCookie(request, CSRF_COOKIE_NAME);
    const header = request.header(CSRF_HEADER_NAME);
    if (cookie === undefined || header === undefined || cookie.length !== header.length) {
      throw new DomainException(appError('FORBIDDEN', 'Request could not be verified'));
    }
  }

  private contextOf(request: Request): RequestContext {
    const forwarded = request.ip;
    const traceHeader = request.header('x-request-id');
    const agent = request.header('user-agent');
    return {
      ipHash: this.fingerprints.ipHash(forwarded),
      userAgent: agent === undefined ? null : agent.slice(0, 512),
      traceId: traceHeader === undefined ? null : traceHeader.slice(0, 64),
    };
  }
}

const readCookie = (request: Request, name: string): string | undefined => {
  const cookies: unknown = (request as Request & { cookies?: Record<string, unknown> }).cookies;
  if (typeof cookies !== 'object' || cookies === null) return undefined;
  const value = (cookies as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
};
