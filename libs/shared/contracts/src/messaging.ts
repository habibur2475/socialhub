/**
 * Messaging contracts.
 *
 * Three shapes, and the reason each is separate:
 *
 *   the *list* row   what an inbox needs — a title, a preview, an unread count and a
 *                    timestamp. It deliberately carries no messages: a list of 20
 *                    conversations must not pull 20 transcripts.
 *   the *message*    immutable. There is no update schema because there is no
 *                    update endpoint; the only mutation is a soft delete.
 *   the *thread*     membership, plus the reader's own cursor.
 *
 * The message body limit is measured in code points, not UTF-16 units: a Bengali
 * message of 4 000 characters is not 4 000 code units, and a limit that counts the
 * wrong thing rejects valid input at an arbitrary point.
 */

import { z } from 'zod';

import { GROUP_MEMBER_LIMIT, MESSAGE_BODY_MAX_LENGTH } from '@socialhub/kernel/browser';

/**
 * Re-exported, not restated: the kernel decides what "too long" means (it counts
 * code points), the CHECK constraint enforces the same number, and a third copy here
 * would be a third chance to disagree.
 */
export { MESSAGE_BODY_MAX_LENGTH };

/** Mirrors `message_threads_title_len`. */
export const THREAD_TITLE_MIN_LENGTH = 1;
export const THREAD_TITLE_MAX_LENGTH = 80;

export const MESSAGE_THREAD_KINDS = ['DIRECT', 'GROUP'] as const;
export type MessageThreadKind = (typeof MESSAGE_THREAD_KINDS)[number];

/**
 * Opening a direct conversation.
 *
 * The request names a *person*, never a thread: the thread identity for a pair is
 * derived (`dm_key`), so two requests from opposite sides converge on one row
 * instead of racing to create two.
 */
export const openDirectThreadRequestSchema = z.object({ accountId: z.string().uuid() }).strict();

export type OpenDirectThreadRequest = z.infer<typeof openDirectThreadRequestSchema>;

export const createGroupThreadRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(THREAD_TITLE_MIN_LENGTH, 'A group needs a name')
      .max(THREAD_TITLE_MAX_LENGTH),
    /**
     * The other members. The creator is added implicitly, so sending your own id is
     * rejected rather than silently deduplicated — a client that does not know who
     * is in the conversation is a client with a bug worth surfacing.
     */
    memberIds: z
      .array(z.string().uuid())
      .min(1, 'Invite at least one person')
      .max(GROUP_MEMBER_LIMIT - 1)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate members'),
  })
  .strict();

export type CreateGroupThreadRequest = z.infer<typeof createGroupThreadRequestSchema>;

export const updateGroupThreadRequestSchema = z
  .object({
    title: z.string().trim().min(THREAD_TITLE_MIN_LENGTH).max(THREAD_TITLE_MAX_LENGTH).optional(),
    locked: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.title !== undefined || body.locked !== undefined, 'Nothing to change');

export type UpdateGroupThreadRequest = z.infer<typeof updateGroupThreadRequestSchema>;

/**
 * Sending a message.
 *
 * `clientId` is the idempotency key: a mobile client that retries after a timeout
 * must not produce two messages. It is echoed back so the sender can reconcile.
 */
export const sendMessageRequestSchema = z
  .object({
    body: z.string().max(MESSAGE_BODY_MAX_LENGTH, 'That message is too long'),
    clientId: z.string().uuid().optional(),
  })
  .strict();

export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

/**
 * Paging the conversation list. Named `conversation*`, not `thread*`: the forum
 * already exports a `threadQuerySchema`, and one barrel with two meanings for the
 * same word is how a query ends up on the wrong endpoint.
 */
export const conversationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    /** Keyset cursor: `last_message_at` and id of the last row, `|`-separated. */
    cursor: z.string().max(120).optional(),
    unreadOnly: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export type ConversationQuery = z.infer<typeof conversationQuerySchema>;

/**
 * Message paging is *backwards*: a transcript opens on the newest message and pages
 * into the past. `before` is therefore the cursor and there is no `after` — the
 * live tail arrives over the event stream, not over a poll.
 */
export const messageQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.string().uuid().optional(),
  })
  .strict();

export type MessageQuery = z.infer<typeof messageQuerySchema>;

export const addMembersRequestSchema = z
  .object({ memberIds: z.array(z.string().uuid()).min(1).max(GROUP_MEMBER_LIMIT) })
  .strict();

export type AddMembersRequest = z.infer<typeof addMembersRequestSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const messageAuthorSchema = z.object({
  accountId: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  avatarKey: z.string().nullable(),
});

export type MessageAuthor = z.infer<typeof messageAuthorSchema>;

export const messageSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  sender: messageAuthorSchema,
  body: z.string(),
  /** True when the sender deleted it; the body is then the placeholder text. */
  deleted: z.boolean(),
  createdAt: z.string(),
  clientId: z.string().nullable(),
});

export type MessageView = z.infer<typeof messageSchema>;

export const threadParticipantSchema = z.object({
  accountId: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  avatarKey: z.string().nullable(),
  /** True for the moderator of a group; always true for both sides of a direct one. */
  owner: z.boolean(),
});

export type ThreadParticipant = z.infer<typeof threadParticipantSchema>;

export const threadSummarySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(MESSAGE_THREAD_KINDS),
  /** Resolved by the kernel's `threadTitle`: the other person's name, or the group's. */
  title: z.string(),
  participants: z.array(threadParticipantSchema),
  lastMessageAt: z.string(),
  lastMessagePreview: z.string().nullable(),
  /** Messages after the reader's cursor, excluding their own. */
  unreadCount: z.number().int().nonnegative(),
  locked: z.boolean(),
  /** Present for a group only: whether the caller may rename, invite and lock. */
  viewerIsOwner: z.boolean(),
});

export type ThreadSummary = z.infer<typeof threadSummarySchema>;

export const threadListResponseSchema = z.object({
  items: z.array(threadSummarySchema),
  nextCursor: z.string().nullable(),
  unreadThreads: z.number().int().nonnegative(),
});

export type ThreadListResponse = z.infer<typeof threadListResponseSchema>;

export const messageListResponseSchema = z.object({
  items: z.array(messageSchema),
  /** The cursor for the next (older) page, or null at the beginning of the thread. */
  nextCursor: z.string().nullable(),
});

export type MessageListResponse = z.infer<typeof messageListResponseSchema>;

/**
 * The event frames pushed over the existing SSE stream.
 *
 * They are shaped here rather than in the web app so the producer and the consumer
 * cannot drift: a `message` frame carries the stored message, not a delta.
 */
export const messageEventSchema = z.object({
  type: z.literal('message'),
  threadId: z.string().uuid(),
  message: messageSchema,
  /** The recipient's unread count in that thread after this message. */
  unreadCount: z.number().int().nonnegative(),
});

export type MessageEvent = z.infer<typeof messageEventSchema>;

export const threadEventSchema = z.object({
  type: z.literal('thread'),
  thread: threadSummarySchema,
});

export type ThreadEvent = z.infer<typeof threadEventSchema>;

/** What a caller is told when a direct conversation cannot be opened. */
export const DIRECT_THREAD_DENIALS = ['BLOCKED', 'NO_RELATIONSHIP'] as const;
export type DirectThreadDenial = (typeof DIRECT_THREAD_DENIALS)[number];
