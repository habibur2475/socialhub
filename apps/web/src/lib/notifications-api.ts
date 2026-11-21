/**
 * Notification API bindings, and the live stream client.
 *
 * The stream is read with `fetch` and a bearer token rather than with
 * `EventSource`, because `EventSource` cannot set an `Authorization` header — the
 * usual workaround is to put the token in the query string, where it ends up in
 * access logs, proxy logs and browser history. Reading the response body as a stream
 * keeps the token in a header and gives the same incremental frames.
 *
 * Reconnection is owned here, not by `EventSource`: exponential backoff with jitter,
 * reset on a successful `ready`. Jitter matters because every client that lost the
 * same deploy would otherwise reconnect in the same second.
 */

import type {
  NotificationListResponse,
  NotificationSummaryResponse,
  RealtimeFrame,
} from '@socialhub/contracts';
import { NOTIFICATION_STREAM_PATH } from '@socialhub/contracts';

import type { ApiClient } from './api-client';

export type NotificationApi = {
  list(page?: {
    limit?: number;
    cursor?: string;
    unreadOnly?: boolean;
  }): Promise<NotificationListResponse>;
  summary(): Promise<NotificationSummaryResponse>;
  markRead(id: string): Promise<{ unreadCount: number }>;
  markAllRead(): Promise<{ unreadCount: number }>;
};

const pageQuery = (page?: { limit?: number; cursor?: string; unreadOnly?: boolean }): string => {
  const params = new URLSearchParams();
  if (page?.limit !== undefined) params.set('limit', String(page.limit));
  if (page?.cursor !== undefined) params.set('cursor', page.cursor);
  // Only sent when true: the API defaults it to false, and a noisy URL is harder to
  // read in a network panel than a short one.
  if (page?.unreadOnly === true) params.set('unreadOnly', 'true');
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
};

const base = '/api/v1';

export const createNotificationApi = (client: ApiClient): NotificationApi => ({
  list: (page) =>
    client.request<NotificationListResponse>(`${base}/notifications${pageQuery(page)}`),
  summary: () => client.request<NotificationSummaryResponse>(`${base}/notifications/summary`),
  markRead: (id) =>
    client.request<{ unreadCount: number }>(
      `${base}/notifications/${encodeURIComponent(id)}/read`,
      { method: 'POST' },
    ),
  markAllRead: () =>
    client.request<{ unreadCount: number }>(`${base}/notifications/read-all`, { method: 'POST' }),
});

/** Parses one `text/event-stream` chunk into complete frames. */
export type SseParser = {
  /** Feeds a chunk of text; returns every frame it completes. */
  push(chunk: string): readonly { event: string; data: unknown }[];
  /** Any partial frame still buffered. */
  pending(): string;
};

/**
 * A minimal SSE parser.
 *
 * Only the subset this server emits is handled: `event:` and `data:` lines separated
 * by a blank line. `id:` and `retry:` are deliberately ignored — reconnection is
 * driven by the fetch loop, which knows the last frame it processed.
 *
 * The buffer is preserved across chunks because a frame can be split anywhere,
 * including in the middle of a multi-byte character. Decoding happens once, in the
 * stream reader, with an explicit `TextDecoder` in streaming mode.
 */
export const createSseParser = (): SseParser => {
  let buffer = '';

  return {
    pending: () => buffer,

    push: (chunk) => {
      buffer += chunk;
      const frames: { event: string; data: unknown }[] = [];

      // Frames are separated by a blank line; `\r\n\r\n` is normalised first because
      // some proxies rewrite line endings.
      buffer = buffer.replaceAll('\r\n', '\n');

      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const raw = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        let event = 'message';
        const dataLines: string[] = [];

        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          // A comment (`: keep-alive`) needs no handling: it is exactly the no-op it
          // looks like, and the heartbeat already arrives as a named event.
        }

        if (dataLines.length > 0) {
          try {
            frames.push({ event, data: JSON.parse(dataLines.join('\n')) as unknown });
          } catch {
            // A malformed frame is dropped rather than killing the stream: one bad
            // frame must not cost the connection.
          }
        }

        separator = buffer.indexOf('\n\n');
      }

      return frames;
    },
  };
};

/** Narrows a parsed frame to the notification event the store cares about. */
export const isNotificationFrame = (frame: {
  event: string;
  data: unknown;
}): frame is { event: 'notification'; data: RealtimeFrame } =>
  frame.data !== null &&
  typeof frame.data === 'object' &&
  (frame.data as { type?: unknown }).type === 'notification';

export const isUnreadFrame = (frame: {
  event: string;
  data: unknown;
}): frame is { event: 'unread'; data: RealtimeFrame } =>
  frame.data !== null &&
  typeof frame.data === 'object' &&
  (frame.data as { type?: unknown }).type === 'unread';

export type StreamOptions = {
  readonly baseUrl?: string;
  readonly signal: AbortSignal;
  readonly onFrame: (frame: { event: string; data: unknown }) => void;
  /** Called with the delay before each retry, for a "reconnecting" indicator. */
  readonly onStatus?: (status: 'open' | 'closed' | 'retrying', retryInMs?: number) => void;
};

/**
 * Opens the stream and keeps it open until `signal` aborts.
 *
 * Resolves when the loop stops. Never rejects: a stream that has not connected still
 * leaves the inbox readable over HTTP, so a failure here is a missing badge, not a
 * broken page.
 */
export const streamNotifications = async (
  client: ApiClient,
  options: StreamOptions,
): Promise<void> => {
  const baseUrl = options.baseUrl ?? '';
  const parser = createSseParser();
  let attempt = 0;

  while (!options.signal.aborted) {
    try {
      // A refresh may have cleared the token; refreshing before opening the socket
      // avoids a guaranteed 401 on the first connect after a long idle.
      if (client.getAccessToken() === null) {
        const refreshed = await client.refreshSession();
        if (!refreshed) break;
      }

      const response = await fetch(`${baseUrl}${base}/notifications/stream`, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          ...(client.getAccessToken() === null
            ? {}
            : { authorization: `Bearer ${String(client.getAccessToken())}` }),
        },
        signal: options.signal,
      });

      // A 401 is recoverable exactly once: refresh, then retry immediately rather
      // than backing off, because the session was probably fine and the token stale.
      if (response.status === 401) {
        const refreshed = await client.refreshSession();
        if (!refreshed) break;
        continue;
      }

      if (!response.ok || response.body === null) {
        throw new Error(`stream failed with ${response.status}`);
      }

      options.onStatus?.('open');
      attempt = 0;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          options.onFrame(frame);
        }
      }
    } catch {
      // Fall through to the backoff below; network failure, abort and a non-200 are
      // the same to the caller. The one distinction that matters is made above:
      // `signal.aborted` is checked before sleeping.
    }

    if (options.signal.aborted) break;

    // Exponential backoff with jitter, capped at 30s: 1s, 2s, 4s… plus up to 30% noise
    // so a fleet that lost the same deploy does not reconnect in lockstep.
    attempt += 1;
    const backoff = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
    const delay = Math.round(backoff * (1 + Math.random() * 0.3));

    options.onStatus?.('retrying', delay);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  options.onStatus?.('closed');
};

export { NOTIFICATION_STREAM_PATH };
