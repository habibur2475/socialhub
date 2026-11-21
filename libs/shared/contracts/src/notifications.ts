/**
 * Notification contracts.
 *
 * The kind list is imported from the kernel rather than restated: the database
 * CHECK constraint, the decision function and this schema must agree, and three
 * copies of a seven-value enum is three chances to disagree.
 *
 * The response shape carries `actors` as a *list* rather than a single actor so
 * the collapsed case renders without a second request — "Ada and 9 others liked
 * your post" is one row, and the row already holds what the sentence needs.
 */

import { z } from 'zod';

import { NOTIFICATION_KINDS, UNREAD_BADGE_CAP } from '@socialhub/kernel/browser';
// Imported for local use *and* re-exported below: `export … from` re-exports do not
// introduce a local binding, so the response type would otherwise not see it.
import type { NotificationSubjectType } from '@socialhub/kernel/browser';

export type { NotificationKind } from '@socialhub/kernel/browser';

/**
 * Re-exported from the kernel rather than restated: the CHECK constraint, the
 * decision function and this union must agree, and a fourth copy is a fourth chance
 * to disagree.
 */
export { NOTIFICATION_SUBJECT_TYPES } from '@socialhub/kernel/browser';
export type { NotificationSubjectType } from '@socialhub/kernel/browser';

/**
 * Inbox paging.
 *
 * `cursor` is the notification id (uuidv7), so ordering by id is ordering by
 * creation and the keyset predicate stays single-column — the same reasoning the
 * feed applies to post ids.
 */
export const notificationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().uuid().optional(),
    // Defaulted rather than optional: the transform runs on `undefined` too, so an
    // optional field whose transform compares to 'true' silently becomes `false`
    // but keeps a `boolean | undefined` type the client has to handle anyway.
    unreadOnly: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export type NotificationQuery = z.infer<typeof notificationQuerySchema>;

/** The minimum an actor name needs; the same shape the feed's author uses. */
export type NotificationActor = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
};

export type NotificationResponse = {
  readonly id: string;
  readonly kind: (typeof NOTIFICATION_KINDS)[number];
  /**
   * The actors behind the row, newest first. A single actor is a list of one;
   * a collapsed row holds up to five, and `actorCount` says how many there were
   * in total, which is what "and N others" is derived from.
   */
  readonly actors: readonly NotificationActor[];
  readonly actorCount: number;
  /** A short excerpt of the thing notified about, or null. Never the full body. */
  readonly preview: string | null;
  readonly subjectType: NotificationSubjectType | null;
  readonly subjectId: string | null;
  readonly read: boolean;
  readonly createdAt: string;
  /** When the row last changed — a collapsed row bubbles to the top on each like. */
  readonly updatedAt: string;
};

export type NotificationListResponse = {
  readonly items: readonly NotificationResponse[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
};

/**
 * The unread badge.
 *
 * `badge` is pre-formatted (`"99+"`) so every surface renders the cap the same
 * way, and `unreadCount` is the real number for the inbox header and the
 * mark-all-read flow.
 */
export type NotificationSummaryResponse = {
  readonly unreadCount: number;
  readonly badge: string;
  /** The cap, echoed so the client does not import a kernel constant to explain it. */
  readonly badgeCap: number;
};

/** The events a real-time stream may deliver. */
export const REALTIME_EVENT_TYPES = ['notification', 'unread', 'ping'] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

/**
 * One frame on the stream.
 *
 * Every frame carries a type so a client can ignore event kinds it does not
 * implement yet — the alternative (raw payloads) makes adding a second event type
 * a breaking change for every deployed client.
 *
 * `ping` exists because proxies and load balancers close an idle connection, and
 * the client's only way to distinguish "quiet" from "dead" is a heartbeat.
 */
export type RealtimeFrame =
  | { readonly type: 'notification'; readonly notification: NotificationResponse }
  | { readonly type: 'unread'; readonly unreadCount: number; readonly badge: string }
  | { readonly type: 'ping'; readonly at: string };

/** The SSE endpoint, relative to the API prefix. */
export const NOTIFICATION_STREAM_PATH = '/notifications/stream';

export { UNREAD_BADGE_CAP };
