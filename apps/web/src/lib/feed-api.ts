/**
 * Feed API bindings.
 *
 * As with the profile bindings, every call goes through the shared `ApiClient` so
 * the in-memory token, single-flight refresh and retry-once behaviour are
 * identical everywhere. Types come from `@socialhub/contracts`, which the API
 * validates against.
 */

import type {
  CreatePostRequest,
  PostResponse,
  TimelineResponse,
  UpdatePostRequest,
} from '@socialhub/contracts';

import type { ApiClient } from './api-client';

export type FeedApi = {
  home(page?: { limit?: number; cursor?: string }): Promise<TimelineResponse>;
  byAuthor(username: string, page?: { limit?: number; cursor?: string }): Promise<TimelineResponse>;
  create(input: CreatePostRequest): Promise<PostResponse>;
  edit(id: string, input: UpdatePostRequest): Promise<PostResponse>;
  remove(id: string): Promise<void>;
  like(id: string): Promise<{ liked: boolean; likeCount: number }>;
  unlike(id: string): Promise<{ liked: boolean; likeCount: number }>;
};

const pageQuery = (page?: { limit?: number; cursor?: string }): string => {
  const params = new URLSearchParams();
  if (page?.limit !== undefined) params.set('limit', String(page.limit));
  if (page?.cursor !== undefined) params.set('cursor', page.cursor);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
};

export const createFeedApi = (client: ApiClient): FeedApi => ({
  home: (page) => client.request<TimelineResponse>(`/api/v1/feed${pageQuery(page)}`),

  byAuthor: (username, page) =>
    client.request<TimelineResponse>(
      `/api/v1/profiles/${encodeURIComponent(username)}/posts${pageQuery(page)}`,
    ),

  create: (input) => client.request<PostResponse>('/api/v1/posts', { method: 'POST', body: input }),

  edit: (id, input) =>
    client.request<PostResponse>(`/api/v1/posts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
    }),

  remove: (id) =>
    client.request<void>(`/api/v1/posts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  like: (id) =>
    client.request<{ liked: boolean; likeCount: number }>(
      `/api/v1/posts/${encodeURIComponent(id)}/like`,
      { method: 'POST' },
    ),

  unlike: (id) =>
    client.request<{ liked: boolean; likeCount: number }>(
      `/api/v1/posts/${encodeURIComponent(id)}/like`,
      { method: 'DELETE' },
    ),
});
