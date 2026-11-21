'use client';

/**
 * The notification inbox.
 *
 * Three behaviours worth naming:
 *
 *   1. **Live prepend, deduplicated.** A notification that arrives while the page is
 *      open is inserted at the top, unless the stream already delivered it. The
 *      de-duplication is by id, because the same row can arrive twice: once from the
 *      stream and once from a refresh triggered by a read.
 *   2. **Reading is optimistic.** The row is marked read in the UI before the request
 *      completes. The badge is the thing users watch, and making it lag behind the
 *      click is the difference between "instant" and "slow" for a one-row update.
 *   3. **Collapsing is explained, not hidden.** A row with three actors says "Ada and
 *      2 others", because a reader who liked a post and sees only one name assumes the
 *      others were not delivered.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  AtSign,
  CheckCheck,
  GraduationCap,
  Heart,
  MessageSquare,
  MessagesSquare,
  UserPlus,
} from 'lucide-react';

import type { NotificationResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { createNotificationApi } from '@/lib/notifications-api';
import { useNotifications } from '@/lib/notifications';
import { describeError } from '@/lib/form';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/time';

type Status = 'loading' | 'ready' | 'error';

/** One icon per kind. A single generic bell makes the list unreadable at a glance. */
const ICONS = {
  FOLLOW: UserPlus,
  LIKE: Heart,
  REPLY: MessageSquare,
  MENTION: AtSign,
  REPOST: MessagesSquare,
  QUIZ_RESULT: GraduationCap,
  THREAD_ANSWER: MessagesSquare,
} as const;

/** Where a notification points. A row that cannot be followed is a dead end. */
const hrefFor = (notification: NotificationResponse): string | null => {
  if (notification.subjectId === null) return null;

  switch (notification.subjectType) {
    case 'post':
      return `/posts/${notification.subjectId}`;
    case 'thread':
      return `/forum/threads/${notification.subjectId}`;
    case 'quiz_set':
      return `/quiz/${notification.subjectId}`;
    case 'account': {
      const actor = notification.actors[0];
      return actor === undefined ? null : `/u/${actor.username}`;
    }
    default:
      return null;
  }
};

/** "Ada", "Ada and Grace", "Ada and 2 others" — the collapse, in words. */
export const describeActors = (notification: NotificationResponse): string => {
  const first = notification.actors[0]?.displayName ?? 'Someone';
  const others = notification.actorCount - 1;

  if (others <= 0) return first;
  if (others === 1) return `${first} and 1 other`;
  return `${first} and ${String(others)} others`;
};

const VERB: Record<NotificationResponse['kind'], string> = {
  FOLLOW: 'followed you',
  LIKE: 'liked your post',
  REPLY: 'replied to your post',
  MENTION: 'mentioned you',
  REPOST: 'reposted your post',
  QUIZ_RESULT: 'completed your quiz',
  THREAD_ANSWER: 'answered your thread',
};

export const NotificationList = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();
  const { markRead, markAllRead, subscribe, unreadCount, setUnreadCount } = useNotifications();

  const [items, setItems] = useState<readonly NotificationResponse[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setStatus('loading');
    setError(null);

    try {
      const page = await createNotificationApi(client).list();
      setItems(page.items);
      setCursor(page.nextCursor);
      setUnreadCount(page.unreadCount);
      setStatus('ready');
    } catch (cause) {
      setError(describeError(cause));
      setStatus('error');
    }
  }, [client, sessionStatus, setUnreadCount]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live prepend. The subscription is separate from `load` so it does not re-register
  // on every render and does not depend on the list already having been fetched.
  useEffect(
    () =>
      subscribe((notification) => {
        setItems((current) => {
          const existing = current.findIndex((item) => item.id === notification.id);
          // A collapsed row updates in place rather than appearing twice: the same
          // post liked by two people is one notification whose text changed.
          if (existing !== -1) {
            const next = [...current];
            next[existing] = notification;
            return next;
          }
          return [notification, ...current];
        });
        setStatus('ready');
      }),
    [subscribe],
  );

  const loadMore = async (): Promise<void> => {
    if (cursor === null) return;
    setLoadingMore(true);

    try {
      const page = await createNotificationApi(client).list({ cursor });
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !seen.has(item.id))];
      });
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  const readOne = async (notification: NotificationResponse): Promise<void> => {
    if (notification.read) return;

    // Optimistic: the badge is what the user is watching.
    setItems((current) =>
      current.map((item) => (item.id === notification.id ? { ...item, read: true } : item)),
    );

    try {
      await markRead(notification.id);
    } catch {
      // Put it back. A badge that silently lies is worse than one that blinks.
      setItems((current) =>
        current.map((item) => (item.id === notification.id ? { ...item, read: false } : item)),
      );
    }
  };

  const readAll = async (): Promise<void> => {
    setItems((current) => current.map((item) => ({ ...item, read: true })));
    try {
      await markAllRead();
    } catch (cause) {
      setError(describeError(cause));
      // The server remains the truth; a reload is the only honest recovery.
      void load();
    }
  };

  if (status === 'loading') {
    return (
      <div className="flex flex-col gap-sm" aria-busy>
        {[0, 1, 2].map((key) => (
          <div key={key} className="flex items-center gap-sm border-b border-border p-md">
            <div className="skeleton size-10 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-xs">
              <div className="skeleton h-4 w-48" />
              <div className="skeleton h-4 w-24" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (status === 'error') {
    return (
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
    );
  }

  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-border p-lg text-body text-muted">
        Nothing yet. Likes, replies and mentions will appear here — live, without a refresh.
      </p>
    );
  }

  const now = new Date();

  return (
    <div className="flex flex-col gap-sm">
      <div className="flex items-center justify-between gap-sm">
        <p className="text-small text-muted">
          {unreadCount === 0 ? 'All caught up' : `${String(unreadCount)} unread`}
        </p>
        {unreadCount > 0 ? (
          <button
            type="button"
            onClick={() => void readAll()}
            className={buttonClass('ghost', 'sm')}
          >
            <CheckCheck aria-hidden className="size-4" />
            Mark all read
          </button>
        ) : null}
      </div>

      <ul className="flex flex-col">
        {items.map((notification) => {
          const Icon = ICONS[notification.kind];
          const href = hrefFor(notification);

          const body = (
            <div className="flex items-start gap-sm">
              <span
                aria-hidden
                className={cn(
                  'mt-[2px] grid size-10 shrink-0 place-items-center rounded-full',
                  notification.read ? 'bg-raised text-muted' : 'bg-primary/10 text-primary',
                )}
              >
                <Icon className="size-5" />
              </span>

              <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <p className={cn('text-body', notification.read ? 'text-muted' : 'text-text')}>
                  <span className="font-medium">{describeActors(notification)}</span>{' '}
                  {VERB[notification.kind]}
                </p>

                {notification.preview === null ? null : (
                  <p className="line-clamp-2 text-small text-muted">{notification.preview}</p>
                )}

                <time
                  dateTime={notification.updatedAt}
                  className="text-caption text-muted"
                  suppressHydrationWarning
                >
                  {relativeTime(notification.updatedAt, now)}
                </time>
              </div>

              {/* A dot, not a colour change alone: colour is not the only signal a
                  reader may be able to perceive. */}
              {notification.read ? null : (
                <span aria-hidden className="mt-sm size-2 shrink-0 rounded-full bg-primary" />
              )}
            </div>
          );

          return (
            <li key={notification.id} className="border-b border-border">
              {href === null ? (
                <div className="p-md">{body}</div>
              ) : (
                <Link
                  href={href}
                  onClick={() => void readOne(notification)}
                  className="block p-md transition-colors duration-fast hover:bg-raised"
                >
                  {body}
                </Link>
              )}
            </li>
          );
        })}
      </ul>

      {cursor === null ? null : (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className={buttonClass('secondary', 'sm', 'self-center')}
        >
          {loadingMore ? 'Loading…' : 'Load older'}
        </button>
      )}
    </div>
  );
};
