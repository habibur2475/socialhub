/**
 * Quiz DTOs.
 *
 * Aliases over the shared contracts, never redefinitions: the schema the browser
 * builds its composer from is the schema this API validates with, so a rule cannot
 * be stricter on one side than the other.
 */

import type {
  CreateQuizSetRequest,
  QuizSetListResponse,
  QuizSetResponse,
  QuizSetQuery,
  QuizAttemptResponse,
  SubmitQuizAttemptRequest,
} from '@socialhub/contracts';

export {
  createQuizSetRequestSchema,
  quizSetQuerySchema,
  submitQuizAttemptRequestSchema,
} from '@socialhub/contracts';

export type CreateQuizSetDto = CreateQuizSetRequest;
export type QuizSetQueryDto = QuizSetQuery;
export type SubmitAttemptDto = SubmitQuizAttemptRequest;
export type QuizSetDto = QuizSetResponse;
export type QuizSetListDto = QuizSetListResponse;
export type QuizAttemptDto = QuizAttemptResponse;
