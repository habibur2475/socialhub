/**
 * Messages index.
 *
 * The list is a client component because it is live: it reacts to frames from the
 * shared SSE stream and inserts a conversation without a reload. The page itself is a
 * server component with a static header, so the heading paints before any script runs.
 */

import { ConversationList } from '@/components/messaging/conversation-list';

export default function MessagesPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <h1 className="text-heading">Messages</h1>
        <p className="text-body text-muted">
          Direct and group conversations. New messages arrive live, and an unread count is the
          number of other people’s messages since you last opened the thread.
        </p>
      </header>

      <ConversationList />
    </div>
  );
}
