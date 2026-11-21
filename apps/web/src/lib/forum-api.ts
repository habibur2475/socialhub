/**
 * Forum API bindings.
 *
 * The category path is URL-encoded rather than sent raw: a path contains slashes, and
 * an unencoded `/general/help` inside a query value is read as part of the path by
 * some proxies before the server ever sees it.
 */

import type {
  CreateAnswerRequest,
  CreateThreadRequest,
  ForumAnswerListResponse,
  ForumAnswerResponse,
  ForumCategoryResponse,
  ForumThreadDetailResponse,
  ForumThreadListResponse,
  ForumThreadResponse,
} from '@socialhub/contracts';

import type { ApiClient } from './api-client';

const base = '/api/v1/forum';

export type ForumApi = {
  categories(): Promise<{ items: readonly ForumCategoryResponse[] }>;
  threads(page?: {
    limit?: number;
    cursor?: string;
    category?: string;
  }): Promise<ForumThreadListResponse>;
  createThread(input: CreateThreadRequest): Promise<ForumThreadResponse>;
  thread(
    id: string,
    page?: { limit?: number; cursor?: string },
  ): Promise<ForumThreadDetailResponse>;
  answers(id: string, page?: { limit?: number; cursor?: string }): Promise<ForumAnswerListResponse>;
  createAnswer(threadId: string, input: CreateAnswerRequest): Promise<ForumAnswerResponse>;
  acceptAnswer(threadId: string, answerId: string): Promise<ForumAnswerResponse>;
  deleteAnswer(answerId: string): Promise<void>;
};

const query = (page?: { limit?: number; cursor?: string; category?: string }): string => {
  const params = new URLSearchParams();
  if (page?.limit !== undefined) params.set('limit', String(page.limit));
  if (page?.cursor !== undefined) params.set('cursor', page.cursor);
  if (page?.category !== undefined) params.set('category', page.category);
  const value = params.toString();
  return value === '' ? '' : `?${value}`;
};

export const createForumApi = (client: ApiClient): ForumApi => ({
  categories: () =>
    client.request<{ items: readonly ForumCategoryResponse[] }>(`${base}/categories`),

  threads: (page) => client.request<ForumThreadListResponse>(`${base}/threads${query(page)}`),

  createThread: (input) =>
    client.request<ForumThreadResponse>(`${base}/threads`, { method: 'POST', body: input }),

  thread: (id, page) =>
    client.request<ForumThreadDetailResponse>(
      `${base}/threads/${encodeURIComponent(id)}${query(page)}`,
    ),

  answers: (id, page) =>
    client.request<ForumAnswerListResponse>(
      `${base}/threads/${encodeURIComponent(id)}/answers${query(page)}`,
    ),

  createAnswer: (threadId, input) =>
    client.request<ForumAnswerResponse>(`${base}/threads/${encodeURIComponent(threadId)}/answers`, {
      method: 'POST',
      body: input,
    }),

  acceptAnswer: (threadId, answerId) =>
    client.request<ForumAnswerResponse>(
      `${base}/threads/${encodeURIComponent(threadId)}/answers/${encodeURIComponent(answerId)}/accept`,
      { method: 'POST' },
    ),

  deleteAnswer: (answerId) =>
    client.request<void>(`${base}/answers/${encodeURIComponent(answerId)}`, { method: 'DELETE' }),
});
