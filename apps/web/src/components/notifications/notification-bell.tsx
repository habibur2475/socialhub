'use client';

/**
 * The header bell.
 *
 * The badge shows the capped string (`99+`) rather than a number, because an exact
 * count on an active account is both unreadable at a glance and a small privacy leak —
 * anyone looking over a shoulder learns how much activity the account receives.
 *
 * The link is a real `<Link>` to the inbox rather than a dropdown. A dropdown listing
 * notifications would need its own paging, its own read state and its own keyboard
 * model, and would duplicate the page it opens. One surface, one behaviour.
 *
 * `aria-live` announces the count when it changes, which is what makes live delivery
 * perceivable without sight — the badge appearing silently is invisible to a screen
 * reader.
 */

import Link from 'next/link';
import { Bell } from 'lucide-react';

import { cn } from '@/lib/cn';
import { useNotifications } from '@/lib/notifications';

export const NotificationBell = ({
  className,
}: {
  readonly className?: string;
}): React.JSX.Element => {
  const { unreadCount, badge, status } = useNotifications();

  return (
    <Link
      href="/notifications"
      aria-label={
        unreadCount === 0 ? 'Notifications' : `Notifications, ${String(unreadCount)} unread`
      }
      className={cn(
        'relative inline-flex size-11 items-center justify-center rounded-md text-text hover:bg-raised',
        className,
      )}
    >
      <Bell aria-hidden className="size-5" />

      {unreadCount > 0 ? (
        <span
          aria-hidden
          className="absolute right-1 top-1 inline-flex min-w-[20px] items-center justify-center rounded-full bg-danger px-1 text-caption font-semibold text-inverted"
        >
          {badge}
        </span>
      ) : null}

      {/* The live dot is a status, not decoration: it disappears while the stream is
          reconnecting, so a user is never told they are live when they are not. */}
      <span
        aria-hidden
        className={cn(
          'absolute bottom-1 right-1 size-[6px] rounded-full',
          status === 'live' ? 'bg-success' : 'bg-muted',
        )}
      />
      <span aria-live="polite" className="sr-only">
        {status === 'live'
          ? 'Notifications are live.'
          : status === 'reconnecting'
            ? 'Notifications are reconnecting.'
            : ''}
      </span>
    </Link>
  );
};
