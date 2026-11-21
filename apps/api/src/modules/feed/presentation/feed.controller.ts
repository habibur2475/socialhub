/**
 * HTTP surface for the feed.
 *
 * Reads and writes are separated so the read routes can later be served by
 * another process without touching the write routes. Every route requires
 * authentication, including the public timeline: the response is personalised
 * (`likedByMe`), and an anonymous variant would need a second visibility path.
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
import { DomainException } from '../../../common/filters/domain-exception.js';
import { appError } from '@socialhub/kernel';
import type { ProfileStore } from '../../profile/application/ports.js';
import { PROFILE_STORE } from '../../profile/profile.tokens.js';
import { FEED_SERVICE } from '../feed.tokens.js';
import type { FeedService } from '../application/feed.service.js';
import {
  type CreatePostDto,
  type PostDto,
  type TimelineDto,
  type TimelineQueryDto,
  type UpdatePostDto,
  createPostRequestSchema,
  timelineQuerySchema,
  updatePostRequestSchema,
} from './dto.js';

@Controller()
@UseGuards(AuthGuard)
export class FeedController {
  public constructor(
    @Inject(FEED_SERVICE) private readonly feed: FeedService,
    // The feed reads by account id; the public route addresses an author by
    // username. Resolving it here keeps the profile module the owner of
    // usernames instead of teaching the feed about them.
    @Inject(PROFILE_STORE) private readonly profiles: ProfileStore,
  ) {}

  @Get('feed')
  public async home(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodPipe(timelineQuerySchema)) query: TimelineQueryDto,
  ): Promise<TimelineDto> {
    return this.feed.homeTimeline(principal.accountId, toPage(query));
  }

  @Get('profiles/:username/posts')
  public async byAuthor(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('username') username: string,
    @Query(new ZodPipe(timelineQuerySchema)) query: TimelineQueryDto,
  ): Promise<TimelineDto> {
    const author = await this.profiles.findByUsername(username);
    // A missing author and an author who has blocked the caller are the same
    // answer, for the same reason the profile route makes them the same.
    if (author === null) throw new DomainException(appError('NOT_FOUND', 'Profile not found'));

    return this.feed.authorTimeline(principal.accountId, author.accountId, toPage(query));
  }

  @Post('posts')
  public async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(createPostRequestSchema)) body: CreatePostDto,
  ): Promise<PostDto> {
    return this.feed.createPost(principal.accountId, body);
  }

  @Get('posts/:id')
  public async read(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<PostDto> {
    return this.feed.getPost(principal.accountId, id);
  }

  @Patch('posts/:id')
  public async edit(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body(new ZodBody(updatePostRequestSchema)) body: UpdatePostDto,
  ): Promise<PostDto> {
    return this.feed.editPost(principal.accountId, id, body.body);
  }

  @Delete('posts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    await this.feed.deletePost(principal.accountId, id);
  }

  @Post('posts/:id/like')
  @HttpCode(HttpStatus.OK)
  public async like(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<{ liked: boolean; likeCount: number }> {
    return this.feed.setLike(principal.accountId, id, true);
  }

  @Delete('posts/:id/like')
  @HttpCode(HttpStatus.OK)
  public async unlike(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<{ liked: boolean; likeCount: number }> {
    return this.feed.setLike(principal.accountId, id, false);
  }
}

const toPage = (query: TimelineQueryDto): { limit: number; cursor: string | null } => ({
  limit: query.limit,
  cursor: query.cursor ?? null,
});
