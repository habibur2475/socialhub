/**
 * HTTP surface for profiles and the social graph.
 *
 * Every route requires authentication, including the read routes. A profile that
 * can be read anonymously needs a second, subtly different visibility path — and
 * two paths that decide the same question is how a private profile leaks. An
 * anonymous visitor is redirected to sign-in by the web layer instead.
 *
 * The controller contains no policy: it validates, delegates one call, and
 * returns. Anything that looks like a rule belongs in `ProfileService`.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentPrincipal } from '../../../common/decorators/current-principal.decorator.js';
import { ZodBody, ZodPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { AuthGuard, type AuthenticatedPrincipal } from '../../auth/presentation/auth.guard.js';
import { PROFILE_SERVICE } from '../profile.tokens.js';
import type { ProfileService } from '../application/profile.service.js';
import {
  type BlockDto,
  type FollowDto,
  type ListDto,
  type ProfileDto,
  type ProfileListDto,
  type UpdateProfileDto,
  blockRequestSchema,
  followRequestSchema,
  listQuerySchema,
  updateProfileRequestSchema,
} from './dto.js';

@Controller()
@UseGuards(AuthGuard)
export class ProfileController {
  public constructor(@Inject(PROFILE_SERVICE) private readonly profiles: ProfileService) {}

  // -------------------------------------------------------------------------
  // Own profile
  // -------------------------------------------------------------------------

  @Get('profile')
  public async getOwn(@CurrentPrincipal() principal: AuthenticatedPrincipal): Promise<ProfileDto> {
    return this.profiles.getOwnProfile(principal.accountId);
  }

  @Patch('profile')
  public async updateOwn(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(updateProfileRequestSchema)) body: UpdateProfileDto,
  ): Promise<ProfileDto> {
    return this.profiles.updateOwnProfile(principal.accountId, body);
  }

  // -------------------------------------------------------------------------
  // Other profiles
  // -------------------------------------------------------------------------

  @Get('profiles/:username')
  public async getByUsername(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('username') username: string,
  ): Promise<ProfileDto> {
    return this.profiles.getProfileByUsername(principal.accountId, username);
  }

  @Get('profiles/:username/followers')
  public async listFollowers(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('username') username: string,
    @Query(new ZodPipe(listQuerySchema)) query: ListDto,
  ): Promise<ProfileListDto> {
    const target = await this.profiles.getProfileByUsername(principal.accountId, username);
    return this.profiles.listFollowers(principal.accountId, target.accountId, toPage(query));
  }

  @Get('profiles/:username/following')
  public async listFollowing(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('username') username: string,
    @Query(new ZodPipe(listQuerySchema)) query: ListDto,
  ): Promise<ProfileListDto> {
    const target = await this.profiles.getProfileByUsername(principal.accountId, username);
    return this.profiles.listFollowing(principal.accountId, target.accountId, toPage(query));
  }

  // -------------------------------------------------------------------------
  // Social graph
  // -------------------------------------------------------------------------

  @Post('social/follow')
  @HttpCode(HttpStatus.OK)
  public async follow(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(followRequestSchema)) body: FollowDto,
  ): Promise<{ following: boolean }> {
    return this.profiles.follow(principal.accountId, body.accountId);
  }

  @Delete('social/follow/:accountId')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async unfollow(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('accountId') accountId: string,
  ): Promise<void> {
    await this.profiles.unfollow(principal.accountId, accountId);
  }

  /**
   * Accepting a pending request is scoped to the caller: the path names the
   * requester, and only the owner of the private profile can accept it, because
   * the service resolves the request as (requester → caller).
   */
  @Post('social/follow-requests/:accountId/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async acceptFollowRequest(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('accountId') accountId: string,
  ): Promise<void> {
    await this.profiles.acceptFollowRequest(principal.accountId, accountId);
  }

  @Post('social/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async block(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(blockRequestSchema)) body: BlockDto,
  ): Promise<void> {
    await this.profiles.block(principal.accountId, body.accountId, body.reason ?? null);
  }

  @Delete('social/block/:accountId')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async unblock(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('accountId') accountId: string,
  ): Promise<void> {
    await this.profiles.unblock(principal.accountId, accountId);
  }
}

/** The query schema defaults `limit` and omits an absent cursor; this narrows both. */
const toPage = (query: ListDto): { limit: number; cursor: string | null } => ({
  limit: query.limit,
  cursor: query.cursor ?? null,
});
