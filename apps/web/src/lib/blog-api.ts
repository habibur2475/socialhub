/**
 * Blog API bindings.
 *
 * One thing here is deliberate: a read accepts an **id or a slug**, because a permalink is
 * a slug and the edit screen has an id, and two routes for the same article would be two
 * visibility implementations.
 *
 * The `mine` flag is only sent when true — the API defaults it to false, and a noisy URL
 * is harder to read in a network panel than a short one.
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

import type { ApiClient } from './api-client';

export type BlogApi = {
  articles(query?: Partial<ArticleQuery>): Promise<ArticleListResponse>;
  tags(): Promise<ArticleTagListResponse>;
  article(idOrSlug: string): Promise<ArticleResponse>;
  create(input: CreateArticleRequest): Promise<ArticleResponse>;
  update(id: string, input: UpdateArticleRequest): Promise<ArticleResponse>;
  publish(id: string, input: PublishArticleRequest): Promise<ArticleResponse>;
  remove(id: string): Promise<void>;
};

const base = '/api/v1/blog';

const queryString = (query?: Partial<ArticleQuery>): string => {
  const params = new URLSearchParams();
  if (query?.limit !== undefined) params.set('limit', String(query.limit));
  if (query?.cursor !== undefined) params.set('cursor', query.cursor);
  if (query?.tag !== undefined) params.set('tag', query.tag);
  if (query?.author !== undefined) params.set('author', query.author);
  if (query?.mine === true) params.set('mine', 'true');
  const value = params.toString();
  return value === '' ? '' : `?${value}`;
};

export const createBlogApi = (client: ApiClient): BlogApi => ({
  articles: (query) => client.request<ArticleListResponse>(`${base}/articles${queryString(query)}`),
  tags: () => client.request<ArticleTagListResponse>(`${base}/tags`),
  article: (idOrSlug) =>
    client.request<ArticleResponse>(`${base}/articles/${encodeURIComponent(idOrSlug)}`),
  create: (input) =>
    client.request<ArticleResponse>(`${base}/articles`, { method: 'POST', body: input }),
  update: (id, input) =>
    client.request<ArticleResponse>(`${base}/articles/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
    }),
  publish: (id, input) =>
    client.request<ArticleResponse>(`${base}/articles/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      body: input,
    }),
  remove: (id) =>
    client.request<void>(`${base}/articles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
});
