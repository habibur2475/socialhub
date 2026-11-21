/**
 * Notifications inbox.
 *
 * A client component: the access token is in memory, so the fetch cannot happen on
 * the server. The page is deliberately thin — the list component owns paging, live
 * prepending and read state, and this file only supplies the heading and the layout.
 */

'use client';

import { NotificationList } from '@/components/notifications/notification-list';

export default function NotificationsPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[640px] flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <h1 className="text-heading">Notifications</h1>
        <p className="text-body text-muted">
          New activity arrives live over a single connection. Nothing here needs a refresh.
        </p>
      </header>

      <NotificationList />
    </div>
  );
}
