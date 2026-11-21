/**
 * Notification rules.
 *
 * Three decisions shape this module, and each of them is a policy rather than a
 * technical detail:
 *
 *   1. **A block silences notifications in both directions.** A blocked account
 *      must not be able to reach the viewer's notification list, or the block is
 *      cosmetic. This is the same rule the feed applies to posts.
 *   2. **Some actions are always silent.** Liking your own post, following
 *      yourself, or replying to yourself must not generate a notification —
 *      self-directed activity is noise, and it is the most common source of it.
 *   3. **Repetition collapses.** Ten likes on one post from ten people is one
 *      notification ("and 9 others"), not ten rows. Without this, a single viral
 *      post makes the notification list unusable, which is how products teach
 *      users to stop reading notifications.
 */

export const NOTIFICATION_KINDS = [
  'FOLLOW',
  'LIKE',
  'REPLY',
  'MENTION',
  'REPOST',
  /** Quiz: a new attempt result on a set you are following, or a grading outcome. */
  'QUIZ_RESULT',
  /** Forum: an answer on your thread. */
  'THREAD_ANSWER',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * What a notification points at.
 *
 * Mirrors the `notifications.subject_type` CHECK constraint. `account` covers a
 * follow (the subject is the follower) and `null` covers nothing at all — the
 * distinction matters because a follow has no content to preview.
 */
export const NOTIFICATION_SUBJECT_TYPES = ['post', 'thread', 'quiz_set', 'account'] as const;

export type NotificationSubjectType = (typeof NOTIFICATION_SUBJECT_TYPES)[number];

/** Kinds that collapse into "X and N others" on the same subject. */
const COLLAPSING_KINDS: ReadonlySet<NotificationKind> = new Set([
  'LIKE',
  'REPOST',
  'FOLLOW',
  'THREAD_ANSWER',
]);

export const collapses = (kind: NotificationKind): boolean => COLLAPSING_KINDS.has(kind);

/**
 * Decides whether an action should produce a notification.
 *
 * Every branch returns a reason, not just a boolean: the service logs the reason,
 * which is what makes "why did I not get a notification" answerable in production
 * without reproducing the request.
 */
export type NotificationDecision =
  | { readonly notify: true; readonly kind: NotificationKind }
  | {
      readonly notify: false;
      readonly reason: 'SELF_ACTION' | 'BLOCKED' | 'NOT_ENTITLED' | 'DUPLICATE' | 'UNKNOWN_KIND';
    };

export type NotificationCandidate = {
  readonly kind: NotificationKind;
  readonly actorId: string;
  readonly recipientId: string;
  /** Whether a block exists between the two, in either direction. */
  readonly blocked: boolean;
  /**
   * Whether the recipient is entitled to know: an accepted follower for a
   * FOLLOWERS-only post, or the owner of a thread. A LIKE on a post the recipient
   * cannot see must never be announced.
   */
  readonly entitled: boolean;
};

export const decideNotification = (candidate: NotificationCandidate): NotificationDecision => {
  // A block is checked before anything else, including the self-action rule, so
  // there is no ordering in which a blocked account produces a row.
  if (candidate.blocked) return { notify: false, reason: 'BLOCKED' };

  if (candidate.actorId === candidate.recipientId) {
    return { notify: false, reason: 'SELF_ACTION' };
  }

  if (!NOTIFICATION_KINDS.includes(candidate.kind)) {
    return { notify: false, reason: 'UNKNOWN_KIND' };
  }

  if (!candidate.entitled) return { notify: false, reason: 'NOT_ENTITLED' };

  return { notify: true, kind: candidate.kind };
};

/**
 * Account ids mentioned in a body.
 *
 * Mentions are extracted server-side rather than sent by the client, because a
 * client-specified recipient list would let anyone notify anyone by claiming a
 * mention that never appeared in the text.
 *
 * The pattern requires a non-word character (or the start) before the `@` so that
 * an email address inside a post — `write to ada@example.test` — does not notify
 * `@example`. That case is common enough to be worth the lookbehind.
 *
 * Duplicates are removed and the result is capped: a body with 500 mentions is an
 * attack, not a conversation.
 */
export const MENTION_LIMIT = 10;

const MENTION_PATTERN = /(?:^|[^\w@])@([a-z0-9_]{3,30})\b/gu;

export const extractMentions = (body: string): readonly string[] => {
  const found = new Set<string>();

  for (const match of body.matchAll(MENTION_PATTERN)) {
    const username = match[1];
    if (username === undefined) continue;
    found.add(username);
    if (found.size >= MENTION_LIMIT) break;
  }

  return [...found];
};

/**
 * Unread counts are capped for display.
 *
 * A badge reading "1,284" is noise, and rendering the exact number leaks how much
 * activity an account receives. "99+" carries the only information the badge needs
 * to carry: there is more than you can act on right now.
 */
export const UNREAD_BADGE_CAP = 99;

export const unreadBadge = (count: number): string =>
  count > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(Math.max(count, 0));
