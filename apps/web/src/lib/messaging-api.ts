/**
 * Messaging API bindings and the live conversation stream.
 *
 * The conversation list is *not* polled. A message arrives on the SSE connection the
 * notification provider already holds open, and the list and the open transcript both
 * react to the same event — which is why this module exposes a subscription rather
 * than a socket of its own.
 *
 * A client id is generated per send attempt and reused on retry: the server keys
 * idempotency on `(thread, sender, clientId)`, so a timeout followed by a retry lands
 * on the message that was already stored instead of duplicating it.
 */

import type {
  AddMembersRequest,
  CreateGroupThreadRequest,
  MessageListResponse,
  MessageView,
  SendMessageRequest,
  ThreadListResponse,
  ThreadSummary,
  UpdateGroupThreadRequest,
} from '@socialhub/contracts';

import type { ApiClient } from './api-client';

const base = '/api/v1/messages';

export type MessageApi = {
  conversations(page?: {
    limit?: number;
    cursor?: string;
    unreadOnly?: boolean;
  }): Promise<ThreadListResponse>;
  conversation(id: string): Promise<ThreadSummary>;
  openDirect(accountId: string): Promise<ThreadSummary>;
  createGroup(input: CreateGroupThreadRequest): Promise<ThreadSummary>;
  messages(id: string, page?: { limit?: number; before?: string }): Promise<MessageListResponse>;
  send(id: string, input: SendMessageRequest): Promise<{ message: MessageView }>;
  markRead(id: string): Promise<{ unreadCount: number }>;
  updateGroup(id: string, patch: UpdateGroupThreadRequest): Promise<ThreadSummary>;
  addMembers(id: string, input: AddMembersRequest): Promise<ThreadSummary>;
  leave(id: string): Promise<void>;
  deleteMessage(id: string, messageId: string): Promise<void>;
};

const pageQuery = (page?: {
  limit?: number;
  cursor?: string;
  before?: string;
  unreadOnly?: boolean;
}): string => {
  const params = new URLSearchParams();
  if (page?.limit !== undefined) params.set('limit', String(page.limit));
  if (page?.cursor !== undefined) params.set('cursor', page.cursor);
  if (page?.before !== undefined) params.set('before', page.before);
  // Only sent when true, matching the API's default.
  if (page?.unreadOnly === true) params.set('unreadOnly', 'true');
  const value = params.toString();
  return value === '' ? '' : `?${value}`;
};

const path = (id: string): string => `${base}/conversations/${encodeURIComponent(id)}`;

export const createMessageApi = (client: ApiClient): MessageApi => ({
  conversations: (page) =>
    client.request<ThreadListResponse>(`${base}/conversations${pageQuery(page)}`),
  conversation: (id) => client.request<ThreadSummary>(path(id)),
  openDirect: (accountId) =>
    client.request<ThreadSummary>(`${base}/direct`, { method: 'POST', body: { accountId } }),
  createGroup: (input) =>
    client.request<ThreadSummary>(`${base}/groups`, { method: 'POST', body: input }),
  messages: (id, page) =>
    client.request<MessageListResponse>(`${path(id)}/messages${pageQuery(page)}`),
  send: (id, input) =>
    client.request<{ message: MessageView }>(`${path(id)}/messages`, {
      method: 'POST',
      body: input,
    }),
  markRead: (id) => client.request<{ unreadCount: number }>(`${path(id)}/read`, { method: 'POST' }),
  updateGroup: (id, patch) =>
    client.request<ThreadSummary>(path(id), { method: 'POST', body: patch }),
  addMembers: (id, input) =>
    client.request<ThreadSummary>(`${path(id)}/members`, { method: 'POST', body: input }),
  leave: (id) => client.request<void>(`${path(id)}/members/me`, { method: 'DELETE' }),
  deleteMessage: (id, messageId) =>
    client.request<void>(`${path(id)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    }),
});

/** A frame type guard narrow enough that a new event type cannot break the client. */
export const isMessageFrame = (
  data: unknown,
): data is { type: 'message'; threadId: string; message: MessageView; unreadCount: number } =>
  data !== null && typeof data === 'object' && (data as { type?: unknown }).type === 'message';

export const isThreadFrame = (data: unknown): data is { type: 'thread'; thread: ThreadSummary } =>
  data !== null && typeof data === 'object' && (data as { type?: unknown }).type === 'thread';

export const isMessageDeletedFrame = (
  data: unknown,
): data is { type: 'message-deleted'; threadId: string; messageId: string; message: MessageView } =>
  data !== null &&
  typeof data === 'object' &&
  (data as { type?: unknown }).type === 'message-deleted';

/**
 * The idempotency key for one send attempt.
 *
 * `crypto.randomUUID` requires a secure context; a development build served over a
 * plain-HTTP LAN address falls back to `getRandomValues`, which is still a uuid.
 */
export const newClientId = (): string => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
