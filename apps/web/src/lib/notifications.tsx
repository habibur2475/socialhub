'use client';

/**
 * Live notifications.
 *
 * One provider owns three things:
 *
 *   the unread count   a single source of truth, updated by the stream and by the
 *                      user's own read actions, so the badge never disagrees with
 *                      the list it opens.
 *   the stream         opened once per signed-in session and closed on sign-out.
 *   an event bus       components subscribe to "a notification arrived" without each
 *                      opening their own connection.
 *
 * Why a provider rather than a hook per component: every subscriber that opened its
 * own stream would be a separate HTTP connection held open for the life of the tab.
 * Browsers cap per-origin connections at six over HTTP/1.1, so two of them would
 * deadlock the app's own requests.
 *
 * The inbox is *not* held here. Notifications are paged and large; the list component
 * fetches its own pages, and this provider only knows how many are unread.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { NotificationResponse } from '@socialhub/contracts';
import { UNREAD_BADGE_CAP } from '@socialhub/contracts';

import {
  createNotificationApi,
  isNotificationFrame,
  isUnreadFrame,
  streamNotifications,
} from './notifications-api';
import { useSession } from './session';

export type NotificationStreamStatus = 'idle' | 'live' | 'reconnecting';

type NotificationContextValue = {
  readonly unreadCount: number;
  readonly badge: string;
  readonly status: NotificationStreamStatus;
  /** The most recent live notification, for a toast or a list prepend. */
  readonly latest: NotificationResponse | null;
  /** Refreshes the count after the user reads something. */
  setUnreadCount: (count: number) => void;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** Subscribes to live notifications. Returns an unsubscribe function. */
  subscribe: (listener: (notification: NotificationResponse) => void) => () => void;
};

const NotificationContext = createContext<NotificationContextValue | null>(null);

export const badgeFor = (count: number): string =>
  count > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(Math.max(count, 0));

export const NotificationProvider = ({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();

  const [unreadCount, setUnreadCountState] = useState(0);
  const [status, setStatus] = useState<NotificationStreamStatus>('idle');
  const [latest, setLatest] = useState<NotificationResponse | null>(null);

  // Listeners live in a ref so subscribing does not re-render the provider, and so the
  // stream callback always sees the current set without being re-created.
  const listeners = useRef(new Set<(notification: NotificationResponse) => void>());

  const api = useMemo(() => createNotificationApi(client), [client]);

  const setUnreadCount = useCallback((count: number) => {
    setUnreadCountState(Math.max(count, 0));
  }, []);

  // The initial count comes from HTTP, not from the stream: a stream only reports
  // what happens while it is connected, so opening the app on an unread inbox would
  // otherwise show zero until the next event.
  useEffect(() => {
    if (sessionStatus !== 'authenticated') {
      setUnreadCountState(0);
      return;
    }

    let cancelled = false;
    void api
      .summary()
      .then((summary) => {
        if (!cancelled) setUnreadCountState(summary.unreadCount);
      })
      // A failed summary is not worth an error state: the badge shows zero and the
      // list itself will report the real failure when opened.
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [api, sessionStatus]);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') {
      setStatus('idle');
      return;
    }

    const controller = new AbortController();

    void streamNotifications(client, {
      signal: controller.signal,
      onStatus: (next, retryInMs) => {
        if (next === 'open') setStatus('live');
        else if (next === 'retrying') setStatus('reconnecting');
        else setStatus('idle');
        // The delay is not rendered: a countdown in the corner is noise, and the
        // status alone tells the user whether new items will appear live.
        void retryInMs;
      },
      onFrame: (frame) => {
        if (isUnreadFrame(frame)) {
          const count = (frame.data as { unreadCount: number }).unreadCount;
          setUnreadCountState(Math.max(count, 0));
          return;
        }

        if (isNotificationFrame(frame)) {
          const notification = (frame.data as { notification: NotificationResponse }).notification;
          setLatest(notification);
          // The unread frame that follows carries the authoritative count; this is
          // the fallback for the frame ordering of a reconnecting client.
          setUnreadCountState((current) => current + 1);
          for (const listener of listeners.current) listener(notification);
        }
      },
    });

    return () => {
      controller.abort();
    };
  }, [client, sessionStatus]);

  const markRead = useCallback(
    async (id: string): Promise<void> => {
      const result = await api.markRead(id);
      setUnreadCountState(result.unreadCount);
    },
    [api],
  );

  const markAllRead = useCallback(async (): Promise<void> => {
    await api.markAllRead();
    setUnreadCountState(0);
  }, [api]);

  const subscribe = useCallback((listener: (notification: NotificationResponse) => void) => {
    const set = listeners.current;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }, []);

  const value = useMemo<NotificationContextValue>(
    () => ({
      unreadCount,
      badge: badgeFor(unreadCount),
      status,
      latest,
      setUnreadCount,
      markRead,
      markAllRead,
      subscribe,
    }),
    [unreadCount, status, latest, setUnreadCount, markRead, markAllRead, subscribe],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
};

export const useNotifications = (): NotificationContextValue => {
  const context = useContext(NotificationContext);
  if (context === null) {
    // A wiring error, not a user-facing state: the provider wraps the authenticated
    // shell, and a component outside it cannot have a meaningful fallback.
    throw new Error('useNotifications must be used inside NotificationProvider');
  }
  return context;
};
