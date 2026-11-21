/**
 * Quiz API bindings.
 *
 * Thin, like every other binding module: the value is in the types coming from
 * `@socialhub/contracts`, so a field renamed on the server breaks this file at compile
 * time rather than at runtime in a browser.
 */

import type {
  CreateQuizSetRequest,
  QuizAttemptResponse,
  QuizSetListResponse,
  QuizSetResponse,
  SubmitQuizAttemptRequest,
} from '@socialhub/contracts';

import type { ApiClient } from './api-client';

const base = '/api/v1/quiz';

export type QuizApi = {
  list(page?: { limit?: number; cursor?: string; mine?: boolean }): Promise<QuizSetListResponse>;
  get(id: string): Promise<QuizSetResponse>;
  create(input: CreateQuizSetRequest): Promise<QuizSetResponse>;
  startAttempt(setId: string): Promise<QuizAttemptResponse>;
  getAttempt(attemptId: string): Promise<QuizAttemptResponse>;
  submitAttempt(attemptId: string, input: SubmitQuizAttemptRequest): Promise<QuizAttemptResponse>;
};

const query = (page?: { limit?: number; cursor?: string; mine?: boolean }): string => {
  const params = new URLSearchParams();
  if (page?.limit !== undefined) params.set('limit', String(page.limit));
  if (page?.cursor !== undefined) params.set('cursor', page.cursor);
  if (page?.mine === true) params.set('mine', 'true');
  const value = params.toString();
  return value === '' ? '' : `?${value}`;
};

export const createQuizApi = (client: ApiClient): QuizApi => ({
  list: (page) => client.request<QuizSetListResponse>(`${base}/sets${query(page)}`),
  get: (id) => client.request<QuizSetResponse>(`${base}/sets/${encodeURIComponent(id)}`),
  create: (input) =>
    client.request<QuizSetResponse>(`${base}/sets`, { method: 'POST', body: input }),
  startAttempt: (setId) =>
    client.request<QuizAttemptResponse>(`${base}/sets/${encodeURIComponent(setId)}/attempts`, {
      method: 'POST',
    }),
  getAttempt: (attemptId) =>
    client.request<QuizAttemptResponse>(`${base}/attempts/${encodeURIComponent(attemptId)}`),
  submitAttempt: (attemptId, input) =>
    client.request<QuizAttemptResponse>(
      `${base}/attempts/${encodeURIComponent(attemptId)}/submit`,
      { method: 'POST', body: input },
    ),
});
