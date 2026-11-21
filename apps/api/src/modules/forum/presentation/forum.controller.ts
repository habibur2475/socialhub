/**
 * Forum HTTP surface.
 *
 * All routes require authentication, like every other resource in this API: a thread
 * is readable by anyone signed in unless a block exists, and an anonymous path would
 * need a second visibility rule that could not know about blocks.
 *
 * Category listing is the one route with no per-viewer input, but it stays behind the
 * guard anyway — a consistent surface is worth more than one fewer session lookup.
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
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentPrincipal } from '../../../common/decorators/current-principal.decorator.js';
import { ZodBody, ZodPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { AuthGuard, type AuthenticatedPrincipal } from '../../auth/presentation/auth.guard.js';
import type { ForumService } from '../application/forum.service.js';
import { FORUM_SERVICE } from '../forum.tokens.js';
import {
  type AnswerListDto,
  type AnswerQueryDto,
  type CreateAnswerDto,
  type CreateThreadDto,
  type ThreadDetailDto,
  type ThreadDto,
  type ThreadListDto,
  type ThreadQueryDto,
  answerQuerySchema,
  createAnswerRequestSchema,
  createThreadRequestSchema,
  threadQuerySchema,
} from './dto.js';

@Controller()
@UseGuards(AuthGuard)
export class ForumController {
  public constructor(@Inject(FORUM_SERVICE) private readonly forum: ForumService) {}

  @Get('forum/categories')
  public async categories(): Promise<{ items: readonly unknown[] }> {
    return { items: await this.forum.categories() };
  }

  @Get('forum/threads')
  public async list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodPipe(threadQuerySchema)) query: ThreadQueryDto,
  ): Promise<ThreadListDto> {
    return this.forum.listThreads(principal.accountId, {
      limit: query.limit,
      cursor: query.cursor ?? null,
      category: query.category ?? null,
    });
  }

  @Post('forum/threads')
  public async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(createThreadRequestSchema)) body: CreateThreadDto,
  ): Promise<ThreadDto> {
    return this.forum.createThread(principal.accountId, body);
  }

  @Get('forum/threads/:id')
  public async detail(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Query(new ZodPipe(answerQuerySchema)) query: AnswerQueryDto,
  ): Promise<ThreadDetailDto> {
    return this.forum.threadDetail(principal.accountId, id, {
      limit: query.limit,
      cursor: query.cursor ?? null,
    });
  }

  @Get('forum/threads/:id/answers')
  public async answers(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Query(new ZodPipe(answerQuerySchema)) query: AnswerQueryDto,
  ): Promise<AnswerListDto> {
    return this.forum.answers(principal.accountId, id, {
      limit: query.limit,
      cursor: query.cursor ?? null,
    });
  }

  @Post('forum/threads/:id/answers')
  public async answer(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body(new ZodBody(createAnswerRequestSchema)) body: CreateAnswerDto,
  ): Promise<unknown> {
    return this.forum.createAnswer(principal.accountId, id, body);
  }

  @Post('forum/threads/:id/answers/:answerId/accept')
  @HttpCode(HttpStatus.OK)
  public async accept(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Param('answerId') answerId: string,
  ): Promise<unknown> {
    return this.forum.acceptAnswer(principal.accountId, id, answerId);
  }

  @Delete('forum/answers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  public async remove(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<void> {
    await this.forum.deleteAnswer(principal.accountId, id);
  }
}
