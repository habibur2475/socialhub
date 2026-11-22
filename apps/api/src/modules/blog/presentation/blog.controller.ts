/**
 * Blog HTTP surface.
 *
 * Every route requires authentication, like every other resource in this API: an
 * anonymous reader would need a second visibility rule, and `can_view_article()` already
 * knows about blocks.
 *
 * Reading accepts an **id or a slug** on the same route. A permalink is a slug, and the
 * edit screen has an id; two routes for the same article would be two pagination and two
 * visibility implementations.
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
import type { BlogService } from '../application/blog.service.js';
import { BLOG_SERVICE } from '../blog.tokens.js';
import {
  type ArticleDto,
  type ArticleListDto,
  type ArticleQueryDto,
  type ArticleTagListDto,
  type CreateArticleDto,
  type PublishArticleDto,
  type UpdateArticleDto,
  articleQuerySchema,
  createArticleRequestSchema,
  publishArticleRequestSchema,
  updateArticleRequestSchema,
} from './dto.js';

@Controller('blog')
@UseGuards(AuthGuard)
export class BlogController {
  public constructor(@Inject(BLOG_SERVICE) private readonly blog: BlogService) {}

  @Get('articles')
  public async list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodPipe(articleQuerySchema)) query: ArticleQueryDto,
  ): Promise<ArticleListDto> {
    return this.blog.list(principal.accountId, query);
  }

  @Get('tags')
  public async tags(): Promise<ArticleTagListDto> {
    return this.blog.tags();
  }

  @Get('articles/:idOrSlug')
  public async detail(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('idOrSlug') idOrSlug: string,
  ): Promise<ArticleDto> {
    return this.blog.detail(principal.accountId, idOrSlug);
  }

  @Post('articles')
  public async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(createArticleRequestSchema)) body: CreateArticleDto,
  ): Promise<ArticleDto> {
    return this.blog.create(principal.accountId, body);
  }

  @Patch('articles/:id')
  public async update(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body(new ZodBody(updateArticleRequestSchema)) body: UpdateArticleDto,
  ): Promise<ArticleDto> {
    return this.blog.update(principal.accountId, id, body);
  }

  /**
   * A status change.
   *
   * `POST`, not `PATCH`: this is a named transition with its own rules, and folding it
   * into the field update would make `PATCH { status }` a second way to reach it with
   * none of the transition checks.
   */
  @Post('articles/:id/publish')
  @HttpCode(HttpStatus.OK)
  public async publish(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body(new ZodBody(publishArticleRequestSchema)) body: PublishArticleDto,
  ): Promise<ArticleDto> {
    return this.blog.publish(principal.accountId, id, body);
  }

  @Delete('articles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    await this.blog.remove(principal.accountId, id);
  }
}
