/**
 * One conversation.
 *
 * The id is read with `useParams` inside a client component because the transcript is a
 * live view: it subscribes to the shared stream, appends frames, and manages its own
 * read cursor. A server-rendered transcript would show a snapshot that never updates.
 */

'use client';

import { useParams } from 'next/navigation';

import { ThreadView } from '@/components/messaging/thread-view';

export default function ConversationPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();

  // Keying on the id remounts the view when the route changes, which resets the draft,
  // the client id and the read cursor instead of carrying them into another thread.
  return <ThreadView key={params.id} threadId={params.id} />;
}
