/**
 * Quiz HTTP surface.
 *
 * Every route requires authentication, including reading a public set: the response
 * is personalised (`myAttempt`, and the answer key is withheld per viewer), so an
 * anonymous variant would be a second visibility path — the thing every other module
 * in this codebase refuses to create.
 */

import {
  Body,
  Controller,
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
import type { QuizService } from '../application/quiz.service.js';
import { QUIZ_SERVICE } from '../quiz.tokens.js';
import {
  type CreateQuizSetDto,
  type QuizAttemptDto,
  type QuizSetDto,
  type QuizSetListDto,
  type QuizSetQueryDto,
  type SubmitAttemptDto,
  createQuizSetRequestSchema,
  quizSetQuerySchema,
  submitQuizAttemptRequestSchema,
} from './dto.js';

@Controller()
@UseGuards(AuthGuard)
export class QuizController {
  public constructor(@Inject(QUIZ_SERVICE) private readonly quiz: QuizService) {}

  @Get('quiz/sets')
  public async list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query(new ZodPipe(quizSetQuerySchema)) query: QuizSetQueryDto,
  ): Promise<QuizSetListDto> {
    return this.quiz.listSets(principal.accountId, {
      limit: query.limit,
      cursor: query.cursor ?? null,
      mine: query.mine,
    });
  }

  @Post('quiz/sets')
  public async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodBody(createQuizSetRequestSchema)) body: CreateQuizSetDto,
  ): Promise<QuizSetDto> {
    return this.quiz.createSet(principal.accountId, body);
  }

  @Get('quiz/sets/:id')
  public async read(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<QuizSetDto> {
    return this.quiz.getSet(principal.accountId, id);
  }

  @Post('quiz/sets/:id/attempts')
  public async start(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<QuizAttemptDto> {
    return this.quiz.startAttempt(principal.accountId, id);
  }

  @Get('quiz/attempts/:id')
  public async attempt(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ): Promise<QuizAttemptDto> {
    return this.quiz.getAttempt(principal.accountId, id);
  }

  @Post('quiz/attempts/:id/submit')
  @HttpCode(HttpStatus.OK)
  public async submit(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
    @Body(new ZodBody(submitQuizAttemptRequestSchema)) body: SubmitAttemptDto,
  ): Promise<QuizAttemptDto> {
    return this.quiz.submitAttempt(principal.accountId, id, body.answers);
  }
}
