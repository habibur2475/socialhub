/**
 * Start a conversation.
 *
 * A client component: the form resolves usernames to profiles before submitting, so a
 * mistyped name is reported under the field instead of after a failed create.
 */

import { NewConversation } from '@/components/messaging/new-conversation';

export default function NewConversationPage(): React.JSX.Element {
  return <NewConversation />;
}
