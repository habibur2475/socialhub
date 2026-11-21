/**
 * Messaging rules.
 *
 * Four decisions shape this module, and each of them is a policy rather than a
 * technical detail:
 *
 *   1. **A block ends the conversation in both directions.** Not "hides new
 *      messages" — the thread becomes unreadable to both parties, including the
 *      history. A blocked person who can still read the thread has a channel; a
 *      blocker who can still read it has to keep looking at someone they removed.
 *   2. **Who may open a direct thread is a function of the pair, not of the
 *      sender's willingness.** Two accounts that follow each other may always
 *      talk. A one-way follow may send the *first* message, and the recipient's
 *      reply is what turns the thread into a conversation — the messaging
 *      equivalent of a follow request. A stranger with no follow relationship
 *      cannot initiate at all.
 *   3. **A group thread is a list of accounts plus its owner.** Membership is
 *      explicit rows, so adding someone is a consent-bearing action and leaving is
 *      one delete: there is no implicit membership to recompute.
 *   4. **Read state is per participant, and monotonic.** A cursor advances and
 *      never retreats, so an out-of-order event cannot mark a read message unread.
 *
 * The distinction between "cannot send" and "cannot see" is deliberate and lives in
 * the return types below: an error that told a stranger *why* they cannot open a
 * thread would confirm the recipient exists and is reachable by someone else.
 */

import { extractMentions } from './notifications.js';

export const MESSAGE_BODY_MAX_LENGTH = 4_000;

/** A direct thread's title is never stored; it is the other participant's name. */
export const GROUP_TITLE_MIN_LENGTH = 1;
export const GROUP_TITLE_MAX_LENGTH = 80;

/** Hard ceiling on a group, so one thread cannot become a broadcast channel. */
export const GROUP_MEMBER_LIMIT = 50;

export const THREAD_KINDS = ['DIRECT', 'GROUP'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

/**
 * Why a message may not be sent.
 *
 * Every case is a distinct refusal because the caller's next action differs: a
 * block is final, a missing relationship is fixable by following, a full group is
 * fixable by removing someone.
 */
export type SendRefusal = 'BLOCKED' | 'NOT_A_MEMBER' | 'THREAD_LOCKED' | 'EMPTY' | 'TOO_LONG';

export type MessageDraftDecision =
  | { readonly allowed: true; readonly body: string }
  | { readonly allowed: false; readonly reason: 'EMPTY' | 'TOO_LONG' };

/**
 * Normalises a message body.
 *
 * Only leading and trailing whitespace is removed: an indented code block and a
 * poem's line breaks are content. Length is counted in code points, so an emoji is
 * one character to the author even though it occupies two UTF-16 units — the same
 * rule the post composer uses, for the same reason.
 */
export const prepareMessageBody = (raw: string): MessageDraftDecision => {
  const body = raw.trim();
  if (body.length === 0) return { allowed: false, reason: 'EMPTY' };
  if ([...body].length > MESSAGE_BODY_MAX_LENGTH) return { allowed: false, reason: 'TOO_LONG' };
  return { allowed: true, body };
};

/**
 * The relationship facts that decide whether a direct thread may exist.
 *
 * Both directions are given separately because "A follows B" and "B follows A" have
 * different consequences: only the *recipient's* follow grants the right to keep
 * sending.
 */
export type DirectMessagingContext = {
  /** Either party has blocked the other. Ends everything. */
  readonly blocked: boolean;
  /** The sender follows the recipient. */
  readonly senderFollowsRecipient: boolean;
  /** The recipient follows the sender. */
  readonly recipientFollowsSender: boolean;
  /** A thread between the two already exists. */
  readonly threadExists: boolean;
};

export type DirectThreadDecision =
  | { readonly allowed: true; readonly reason: 'MUTUAL' | 'EXISTING' | 'ONE_WAY' }
  | { readonly allowed: false; readonly reason: 'BLOCKED' | 'NO_RELATIONSHIP' };

/**
 * Whether a direct thread may be opened (or an existing one used).
 *
 * The ordering is the policy: a block is checked first and defeats a mutual follow,
 * because "we follow each other" is not consent to talk to someone who has since
 * blocked you. An existing thread outranks a one-way follow, because a conversation
 * that already exists does not need permission to continue.
 */
export const decideDirectThread = (context: DirectMessagingContext): DirectThreadDecision => {
  if (context.blocked) return { allowed: false, reason: 'BLOCKED' };

  if (context.threadExists) return { allowed: true, reason: 'EXISTING' };

  if (context.senderFollowsRecipient && context.recipientFollowsSender) {
    return { allowed: true, reason: 'MUTUAL' };
  }

  // A one-way follow may *start* a conversation. The recipient still has to reply,
  // which is what makes the thread mutual — the same shape as a follow request.
  if (context.senderFollowsRecipient) return { allowed: true, reason: 'ONE_WAY' };

  return { allowed: false, reason: 'NO_RELATIONSHIP' };
};

/**
 * Whether a message may be sent into a thread the sender is a member of.
 *
 * `locked` is what a moderator (or the owner of a group) can set; a direct thread
 * has no owner who could lock it, so this only fires for groups.
 */
export const decideSend = (input: {
  readonly isMember: boolean;
  readonly locked: boolean;
  readonly blocked: boolean;
}): { readonly allowed: true } | { readonly allowed: false; readonly reason: SendRefusal } => {
  // A block outranks membership in both directions: a group does not give a blocked
  // account a way back into someone's conversation.
  if (input.blocked) return { allowed: false, reason: 'BLOCKED' };
  if (!input.isMember) return { allowed: false, reason: 'NOT_A_MEMBER' };
  if (input.locked) return { allowed: false, reason: 'THREAD_LOCKED' };
  return { allowed: true };
};

/**
 * The inbox preview.
 *
 * Truncated to one line's worth of characters, and newlines are collapsed: a
 * preview is a hint, not the message, and a multi-line body in a list row breaks
 * every layout it is put into.
 */
export const PREVIEW_LENGTH = 120;

export const messagePreview = (body: string): string => {
  const flat = body.replace(/\s+/gu, ' ').trim();
  const characters = [...flat];
  return characters.length <= PREVIEW_LENGTH
    ? flat
    : `${characters.slice(0, PREVIEW_LENGTH - 1).join('')}…`;
};

/**
 * Account ids mentioned in a message.
 *
 * Re-exported from the notification rules rather than re-implemented: an email
 * address inside a message must not parse as a mention, and that lookbehind exists
 * in exactly one place. A message mentions at most the notification limit, which is
 * what keeps one message from dispatching an unbounded number of rows.
 */
export const extractMessageMentions = extractMentions;

/**
 * Whether an unread count should be shown for a thread.
 *
 * A thread with unread messages from the reader's own account only is not unread:
 * a message you sent from another tab is not news to you. The caller passes the
 * count of *other people's* messages after the read cursor.
 */
export const isUnread = (unreadFromOthers: number): boolean => unreadFromOthers > 0;

/**
 * The conversation's display name for a viewer.
 *
 * A direct thread has no title of its own, and inventing one at write time would make
 * it wrong the moment the other person renames themselves. A group thread uses its
 * stored title, and falls back to the member list when the title is blank rather than
 * rendering an empty header.
 */
export const threadTitle = (input: {
  readonly kind: ThreadKind;
  readonly groupTitle: string | null;
  readonly otherDisplayName: string | null;
  readonly memberNames: readonly string[];
}): string => {
  if (input.kind === 'DIRECT') return input.otherDisplayName ?? 'Conversation';

  const title = input.groupTitle?.trim() ?? '';
  if (title.length > 0) return title;

  const names = input.memberNames.slice(0, 3).join(', ');
  return names.length === 0 ? 'Group conversation' : names;
};

/**
 * How the list orders threads.
 *
 * Recency first, with an unread thread ahead of a read one. The comparison is a
 * tuple rather than a weighted score: "unread" is a boolean, and folding it into a
 * number would make a very old unread thread outrank a message from a minute ago.
 */
export const compareThreads = (
  a: { readonly lastMessageAt: Date; readonly unread: boolean },
  b: { readonly lastMessageAt: Date; readonly unread: boolean },
): number => {
  if (a.unread !== b.unread) return a.unread ? -1 : 1;
  return b.lastMessageAt.getTime() - a.lastMessageAt.getTime();
};
