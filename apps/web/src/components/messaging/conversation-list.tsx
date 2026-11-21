'use client';

/**
 * The conversation list.
 *
 * Three behaviours are worth defending:
 *
 * 1. **It is live.** A `message` frame from the shared SSE stream prepends or moves the
 *    thread to the top with its new unread count, so a reply appears without a poll.
 *    The stream is the notification provider's, not a second connection.
 * 2. **Unread is a property of the row, not a decoration.** The count is rendered from
 *    `unreadCount`, which the server computes from the reader's cursor and excludes the
 *    reader's own messages.
 * 3. **A direct thread's title comes from the server**, resolved per viewer, so the list
 *    never has to know that a direct conversation has no stored name.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MessagesSquare, Users } from 'lucide-react';

import type { ThreadSummary } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createMessageApi } from '@/lib/messaging-api';
import { useNotificationStream } from '@/lib/notification-stream';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/time';

type Status = 'loading' | 'ready' | 'error';

export const ConversationList = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();

  const [threads, setThreads] = useState<readonly ThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const api = useMemo(() => createMessageApi(client), [client]);

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setStatus('loading');
    setError(null);

    try {
      const page = await api.conversations(unreadOnly ? { unreadOnly: true } : {});
      setThreads(page.items);
      setCursor(page.nextCursor);
      setStatus('ready');
    } catch (cause) {
      setError(describeError(cause));
      setStatus('error');
    }
  }, [api, sessionStatus, unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A live frame replaces the row or inserts it.
   *
   * Inserting rather than refetching keeps the scroll position and avoids a request per
   * message; the server already ordered the list, and one frame carries one thread.
   */
  const applyThread = useCallback((thread: ThreadSummary) => {
    setThreads((current) => {
      const others = current.filter((entry) => entry.id !== thread.id);
      return [thread, ...others];
    });
  }, []);

  useNotificationStream((data) => {
    if (typeof data !== 'object' || data === null) return;
    const frame = data as {
      type?: unknown;
      thread?: ThreadSummary;
      message?: { threadId: string };
    };

    if (frame.type === 'thread' && frame.thread !== undefined) {
      applyThread(frame.thread);
      return;
    }

    // A message frame with no thread payload (the sender's own tab) still changes the
    // preview, so the row is refreshed from the API rather than left stale.
    if (frame.type === 'message' && frame.thread === undefined) {
      void load();
    }
  });

  const loadMore = async (): Promise<void> => {
    if (cursor === null) return;
    setLoadingMore(true);

    try {
      const page = await api.conversations({
        cursor,
        ...(unreadOnly ? { unreadOnly: true } : {}),
      });
      setThreads((current) => {
        const seen = new Set(current.map((thread) => thread.id));
        return [...current, ...page.items.filter((thread) => !seen.has(thread.id))];
      });
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  const now = new Date();

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex flex-wrap items-center gap-xs">
        <button
          type="button"
          onClick={() => setUnreadOnly(false)}
          aria-current={unreadOnly ? undefined : 'true'}
          className={cn(
            'h-9 rounded-full px-sm text-small transition-colors',
            unreadOnly ? 'text-muted hover:bg-raised' : 'bg-primary/10 font-medium text-primary',
          )}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setUnreadOnly(true)}
          aria-current={unreadOnly ? 'true' : undefined}
          className={cn(
            'h-9 rounded-full px-sm text-small transition-colors',
            unreadOnly ? 'bg-primary/10 font-medium text-primary' : 'text-muted hover:bg-raised',
          )}
        >
          Unread
        </button>
        <Link href="/messages/new" className={cn(buttonClass('secondary', 'sm'), 'ml-auto')}>
          New conversation
        </Link>
      </div>

      {status === 'loading' ? (
        <div className="flex flex-col gap-sm" aria-busy>
          {[0, 1, 2].map((key) => (
            <div key={key} className="flex flex-col gap-xs rounded-lg border border-border p-md">
              <div className="skeleton h-5 w-48" />
              <div className="skeleton h-4 w-64" />
            </div>
          ))}
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="flex flex-col gap-sm rounded-lg border border-border p-md">
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="self-start text-small font-medium text-primary underline"
          >
            Try again
          </button>
        </div>
      ) : null}

      {status === 'ready' && threads.length === 0 ? (
        <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-lg">
          <MessagesSquare aria-hidden className="size-6 text-muted" />
          <p className="text-body text-muted">
            {unreadOnly
              ? 'Nothing unread. Everything here has been read.'
              : 'No conversations yet. Open someone’s profile and send the first message.'}
          </p>
          <Link href="/messages/new" className={buttonClass('primary', 'sm')}>
            Start a conversation
          </Link>
        </div>
      ) : null}

      {threads.length > 0 ? (
        <ul className="flex flex-col">
          {threads.map((thread) => (
            <li key={thread.id} className="border-b border-border">
              <Link
                href={`/messages/${thread.id}`}
                className="flex flex-col gap-[2px] p-md transition-colors duration-fast hover:bg-raised"
              >
                <span className="flex items-center gap-xs text-body font-medium">
                  {thread.kind === 'GROUP' ? (
                    <Users aria-label="Group" className="size-3 shrink-0 text-muted" />
                  ) : null}
                  <span className={cn('truncate', thread.unreadCount > 0 && 'font-semibold')}>
                    {thread.title}
                  </span>
                  {thread.unreadCount > 0 ? (
                    <span
                      aria-label={`${thread.unreadCount} unread`}
                      className="ml-auto shrink-0 rounded-full bg-primary px-[6px] py-[1px] text-caption font-medium text-on-primary"
                    >
                      {thread.unreadCount}
                    </span>
                  ) : null}
                </span>

                <span className="flex items-center gap-xs text-caption text-muted">
                  <span className="truncate">{thread.lastMessagePreview ?? 'No messages yet'}</span>
                  <span aria-hidden>·</span>
                  <span suppressHydrationWarning className="shrink-0">
                    {relativeTime(thread.lastMessageAt, now)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {cursor !== null ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className={cn(buttonClass('secondary', 'sm'), 'self-center')}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
};
