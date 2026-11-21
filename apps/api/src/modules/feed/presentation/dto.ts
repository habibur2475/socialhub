/**
 * Feed DTOs — aliases over the shared contracts, never redefinitions.
 */

import type {
  CreatePostRequest,
  PostResponse,
  TimelineQuery,
  TimelineResponse,
  UpdatePostRequest,
} from '@socialhub/contracts';

export {
  createPostRequestSchema,
  timelineQuerySchema,
  updatePostRequestSchema,
} from '@socialhub/contracts';

export type CreatePostDto = CreatePostRequest;
export type UpdatePostDto = UpdatePostRequest;
export type TimelineQueryDto = TimelineQuery;
export type PostDto = PostResponse;
export type TimelineDto = TimelineResponse;
