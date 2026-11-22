/**
 * Blog DTOs — aliases over the shared contracts, never redefinitions.
 */

import type {
  ArticleListResponse,
  ArticleQuery,
  ArticleResponse,
  ArticleTagListResponse,
  CreateArticleRequest,
  PublishArticleRequest,
  UpdateArticleRequest,
} from '@socialhub/contracts';

export {
  articleQuerySchema,
  createArticleRequestSchema,
  publishArticleRequestSchema,
  updateArticleRequestSchema,
} from '@socialhub/contracts';

export type CreateArticleDto = CreateArticleRequest;
export type UpdateArticleDto = UpdateArticleRequest;
export type PublishArticleDto = PublishArticleRequest;
export type ArticleQueryDto = ArticleQuery;
export type ArticleDto = ArticleResponse;
export type ArticleListDto = ArticleListResponse;
export type ArticleTagListDto = ArticleTagListResponse;
