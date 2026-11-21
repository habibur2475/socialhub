/**
 * Notification ports.
 *
 * Two ports, because producing a notification and reading an inbox are different
 * problems:
 *
 *   NotificationStore  the collapsed rows, the inbox query, the read markers.
 *   RealtimeHub        fan-out of a newly written row to whatever connections
 *                      that recipient currently holds.
 *
 * The hub is an interface because in-process fan-out is only correct for a single
 * replica. A multi-replica deployment needs a Redis pub/sub (or a database LISTEN)
 * bridge behind the same three methods, and that swap must not touch the use case.
 */

import type { NotificationKind, NotificationSubjectType } from '@socialhub/kernel';

export type NotificationActorRecord = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
};

export type NotificationRecord = {
  readonly id: string;
  readonly recipientId: string;
  readonly kind: NotificationKind;
  readonly actors: readonly NotificationActorRecord[];
  readonly actorCount: number;
  readonly subjectType: NotificationSubjectType | null;
  readonly subjectId: string | null;
  readonly preview: string | null;
  readonly read: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What a producer asks for.
 *
 * `groupKey` is supplied by the caller, not derived here: the producer is the only
 * code that knows what "the same event" means for its feature (one post, one
 * thread, or the actor themselves for a follow).
 */
export type NotificationWrite = {
  readonly id: string;
  readonly recipientId: string;
  readonly kind: NotificationKind;
  readonly actorId: string;
  readonly groupKey: string;
  readonly subjectType: NotificationSubjectType | null;
  readonly subjectId: string | null;
  readonly preview: string | null;
};

export type NotificationPage = {
  readonly items: readonly NotificationRecord[];
  readonly hasMore: boolean;
  readonly unreadCount: number;
};

export type NotificationQuery = {
  readonly recipientId: string;
  readonly limit: number;
  readonly cursor: string | null;
  readonly unreadOnly: boolean;
};

export type NotificationStore = {
  /**
   * Writes a notification, collapsing onto an existing row for the same
   * (recipient, group_key).
   *
   * Returns the row as stored — after collapsing — so the real-time frame carries
   * the aggregate ("3 people liked this") rather than the single new actor. The
   * write itself is what makes collapsing atomic; doing it in two statements would
   * let two concurrent likes both insert.
   */
  upsert(write: NotificationWrite): Promise<NotificationRecord | null>;
  list(query: NotificationQuery): Promise<NotificationPage>;
  unreadCount(recipientId: string): Promise<number>;
  /** Marks one row read. Returns false when it is not the caller's row. */
  markRead(recipientId: string, notificationId: string): Promise<boolean>;
  /** Marks everything read. Returns how many rows changed. */
  markAllRead(recipientId: string): Promise<number>;
  find(recipientId: string, notificationId: string): Promise<NotificationRecord | null>;
};

/**
 * Real-time fan-out.
 *
 * `publish` is fire-and-forget on purpose: a notification that was written but not
 * delivered live is still in the inbox on the next read. Making delivery part of
 * the write's success path would let a slow or absent subscriber fail a like.
 */
export type RealtimeHub = {
  publish(recipientId: string, frame: unknown): void;
};

/** The pair (blocked, entitled) a notification decision needs. */
export type NotificationContext = {
  readonly blocked: boolean;
  readonly entitled: boolean;
};
