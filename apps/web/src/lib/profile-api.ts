/**
 * Profile API bindings.
 *
 * Every call goes through the shared `ApiClient`, so the in-memory access token,
 * the single-flight refresh and the retry-once-on-401 behaviour are identical to
 * every other authenticated request. Re-implementing `fetch` here would duplicate
 * the auth rules and eventually get them wrong.
 *
 * Types come from `@socialhub/contracts`, which is also what the API validates
 * against, so a field renamed on the server fails this module at compile time.
 */

import type {
  BlockRequest,
  ProfileListResponse,
  ProfileResponse,
  UpdateProfileRequest,
} from '@socialhub/contracts';

import type { ApiClient } from './api-client';

export type ProfileApi = {
  getOwn(): Promise<ProfileResponse>;
  update(input: UpdateProfileRequest): Promise<ProfileResponse>;
  getByUsername(username: string): Promise<ProfileResponse>;
  listFollowers(
    username: string,
    page?: { limit?: number; cursor?: string },
  ): Promise<ProfileListResponse>;
  listFollowing(
    username: string,
    page?: { limit?: number; cursor?: string },
  ): Promise<ProfileListResponse>;
  follow(accountId: string): Promise<{ following: boolean }>;
  unfollow(accountId: string): Promise<void>;
  block(input: BlockRequest): Promise<void>;
  unblock(accountId: string): Promise<void>;
};

/** Builds the query string, omitting absent values rather than sending "undefined". */
const pageQuery = (page?: { limit?: number; cursor?: string }): string => {
  const params = new URLSearchParams();
  if (page?.limit !== undefined) params.set('limit', String(page.limit));
  if (page?.cursor !== undefined) params.set('cursor', page.cursor);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
};

export const createProfileApi = (client: ApiClient): ProfileApi => ({
  getOwn: () => client.request<ProfileResponse>('/api/v1/profile'),

  update: (input) =>
    client.request<ProfileResponse>('/api/v1/profile', { method: 'PATCH', body: input }),

  getByUsername: (username) =>
    client.request<ProfileResponse>(`/api/v1/profiles/${encodeURIComponent(username)}`),

  listFollowers: (username, page) =>
    client.request<ProfileListResponse>(
      `/api/v1/profiles/${encodeURIComponent(username)}/followers${pageQuery(page)}`,
    ),

  listFollowing: (username, page) =>
    client.request<ProfileListResponse>(
      `/api/v1/profiles/${encodeURIComponent(username)}/following${pageQuery(page)}`,
    ),

  follow: (accountId) =>
    client.request<{ following: boolean }>('/api/v1/social/follow', {
      method: 'POST',
      body: { accountId },
    }),

  unfollow: (accountId) =>
    client.request<void>(`/api/v1/social/follow/${encodeURIComponent(accountId)}`, {
      method: 'DELETE',
    }),

  block: (input) => client.request<void>('/api/v1/social/block', { method: 'POST', body: input }),

  unblock: (accountId) =>
    client.request<void>(`/api/v1/social/block/${encodeURIComponent(accountId)}`, {
      method: 'DELETE',
    }),
});
