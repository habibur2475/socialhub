/**
 * Forum DTOs.
 *
 * Aliases over the shared contracts, so the topic form in the browser and the
 * validator here cannot disagree about a title's minimum length.
 */

import type {
  AnswerQuery,
  CreateAnswerRequest,
  CreateThreadRequest,
  ForumAnswerListResponse,
  ForumThreadDetailResponse,
  ForumThreadListResponse,
  ForumThreadResponse,
  ThreadQuery,
} from '@socialhub/contracts';

export {
  answerQuerySchema,
  createAnswerRequestSchema,
  createThreadRequestSchema,
  threadQuerySchema,
} from '@socialhub/contracts';

export type CreateThreadDto = CreateThreadRequest;
export type CreateAnswerDto = CreateAnswerRequest;
export type ThreadQueryDto = ThreadQuery;
export type AnswerQueryDto = AnswerQuery;
export type ThreadDto = ForumThreadResponse;
export type ThreadListDto = ForumThreadListResponse;
export type AnswerListDto = ForumAnswerListResponse;
export type ThreadDetailDto = ForumThreadDetailResponse;
