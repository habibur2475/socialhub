/**
 * Messaging ports.
 *
 * One store, plus the realtime hub the notifications module already owns. The hub is
 * shared rather than duplicated: a message and a notification arrive on the same
 * connection, and a second hub would mean a second SSE endpoint that the browser had
 * to keep open in parallel.
 *
 * `can_view_conversation()` is applied inside every read here — the service never
 * filters afterwards — so there is exactly one place that decides who sees a
 * conversation, and it is the same one the indexes are built for.
 */

import type { ThreadKind } from '@socialhub/kernel';

export type MessageParticipantRecord = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
  readonly owner: boolean;
  /** Null while the member is still in the conversation. */
  readonly leftAt: Date | null;
};

export type MessageRecord = {
  readonly id: string;
  readonly threadId: string;
  readonly senderId: string;
  readonly sender: Omit<MessageParticipantRecord, 'owner' | 'leftAt'>;
  readonly body: string;
  readonly deleted: boolean;
  readonly createdAt: Date;
  readonly clientId: string | null;
};

/**
 * A row of the inbox.
 *
 * `unreadCount` counts *other people's* messages after the caller's cursor: a message
 * the reader sent from another tab is not news to them.
 */
export type ConversationRecord = {
  readonly id: string;
  readonly kind: ThreadKind;
  readonly title: string | null;
  readonly ownerId: string;
  readonly locked: boolean;
  readonly participants: readonly MessageParticipantRecord[];
  readonly lastMessageAt: Date;
  readonly lastMessagePreview: string | null;
  readonly unreadCount: number;
};

export type ConversationPage = {
  readonly items: readonly ConversationRecord[];
  readonly hasMore: boolean;
  /** Threads with at least one unread message, for the badge. */
  readonly unreadThreads: number;
};

export type MessagePage = {
  /** Newest first, because the transcript is paged backwards. */
  readonly items: readonly MessageRecord[];
  readonly hasMore: boolean;
};

/** What a direct thread needs to know about a pair, read in one round trip. */
export type DirectPairFacts = {
  readonly blocked: boolean;
  readonly senderFollowsRecipient: boolean;
  readonly recipientFollowsSender: boolean;
  readonly threadId: string | null;
};

/** What a send needs to know about a thread, read in one round trip. */
export type SendFacts = {
  readonly threadId: string;
  readonly kind: ThreadKind;
  readonly ownerId: string;
  readonly locked: boolean;
  readonly isMember: boolean;
  /** A block exists between the sender and any live participant. */
  readonly blocked: boolean;
  readonly participantIds: readonly string[];
};

export type ConversationStore = {
  /** Null when the account does not exist or cannot be messaged. */
  directPairFacts(senderId: string, recipientId: string): Promise<DirectPairFacts | null>;

  /** The facts a send is decided on. Null when the thread does not exist. */
  sendFacts(threadId: string, senderId: string): Promise<SendFacts | null>;

  /**
   * Creates a direct thread for a pair, or returns the existing one.
   *
   * The unordered `dm_key` unique index is what makes this safe under concurrency:
   * two simultaneous requests produce one row and the second read returns it.
   */
  ensureDirectThread(input: {
    readonly id: string;
    readonly ownerId: string;
    readonly otherId: string;
  }): Promise<ConversationRecord>;

  createGroupThread(input: {
    readonly id: string;
    readonly ownerId: string;
    readonly title: string;
    readonly memberIds: readonly string[];
  }): Promise<ConversationRecord>;

  listConversations(
    viewerId: string,
    page: { readonly limit: number; readonly cursor: string | null; readonly unreadOnly: boolean },
  ): Promise<ConversationPage>;

  findConversation(viewerId: string, threadId: string): Promise<ConversationRecord | null>;

  listMessages(
    viewerId: string,
    threadId: string,
    page: { readonly limit: number; readonly before: string | null },
  ): Promise<MessagePage>;

  /** Inserts the message and returns it joined with its sender. */
  appendMessage(input: {
    readonly id: string;
    readonly threadId: string;
    readonly senderId: string;
    readonly body: string;
    readonly clientId: string | null;
  }): Promise<MessageRecord>;

  /** Returns the message with that client id, for the idempotent retry path. */
  findMessageByClientId(
    threadId: string,
    senderId: string,
    clientId: string,
  ): Promise<MessageRecord | null>;

  /**
   * Moves the caller's read cursor forward. Returns the thread's unread count after
   * the move, which is what the badge and the SSE frame both need.
   */
  markRead(viewerId: string, threadId: string, messageId: string): Promise<number>;

  /** Rows after the reader's cursor in this thread, excluding the reader's own. */
  unreadCount(viewerId: string, threadId: string): Promise<number>;

  /**
   * Adds members to a group. Returns the ids actually added, so the caller notifies
   * the newcomers and nobody else.
   */
  addMembers(input: {
    readonly threadId: string;
    readonly memberIds: readonly string[];
  }): Promise<readonly string[]>;

  removeMember(threadId: string, accountId: string): Promise<boolean>;

  updateGroup(
    viewerId: string,
    threadId: string,
    patch: { readonly title?: string; readonly locked?: boolean },
  ): Promise<ConversationRecord | null>;

  /** Soft delete. Only the sender may delete, and only their own message. */
  deleteMessage(
    threadId: string,
    messageId: string,
    senderId: string,
  ): Promise<MessageRecord | null>;
};
