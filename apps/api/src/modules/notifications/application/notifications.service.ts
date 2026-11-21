/**
 * Notification use cases.
 *
 * The policy lives in the kernel (`decideNotification`); this service's job is to
 * assemble the facts that decision needs, and to refuse to produce a row when the
 * decision says no. Three consequences worth stating:
 *
 * 1. **Notifications are a side effect, never the reason a write fails.** `notify`
 *    swallows a store failure after logging it: a like that succeeded but could not
 *    be announced is a missing badge, while a like reported as failed when it was
 *    actually stored is a duplicate on retry.
 * 2. **The recipient is resolved from the subject, not from the request.** A client
 *    never names a recipient; see `extractMentions` for the mention case.
 * 3. **A block is checked through the caller-supplied context**, so the same rule
 *    that hides a post hides its notification.
 */

import { Inject, Injectable } from '@nestjs/common';

import {
  appError,
  decideNotification,
  extractMentions,
  unreadBadge,
  type NotificationKind,
  type NotificationSubjectType,
} from '@socialhub/kernel';

import { DomainException } from '../../../common/filters/domain-exception.js';
import { JsonLogger } from '../../../common/logging/logger.js';
import type { IdGenerator } from '../../auth/application/ports.js';
import { IDS } from '../../auth/auth.tokens.js';
import type {
  NotificationContext,
  NotificationRecord,
  NotificationStore,
  RealtimeHub,
} from './ports.js';
import { NOTIFICATION_STORE, REALTIME_HUB } from '../notifications.tokens.js';

/** Everything a producer must supply; the recipient is part of it. */
export type NotifyInput = {
  readonly kind: NotificationKind;
  readonly recipientId: string;
  readonly actorId: string;
  /** Collapsing identity: `like:<postId>`, `follow`, `thread-answer:<threadId>`. */
  readonly groupKey: string;
  readonly subjectType: NotificationSubjectType | null;
  readonly subjectId: string | null;
  /** A short excerpt. Truncated here, once, rather than in every caller. */
  readonly preview: string | null;
  readonly context: NotificationContext;
};

export type NotificationView = {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly actors: NotificationRecord['actors'];
  readonly actorCount: number;
  readonly preview: string | null;
  readonly subjectType: NotificationSubjectType | null;
  readonly subjectId: string | null;
  readonly read: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type NotificationListView = {
  readonly items: readonly NotificationView[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
};

/** Previews are excerpts, not copies: 140 characters is a notification, not a page. */
export const PREVIEW_MAX_LENGTH = 140;

const truncate = (value: string | null): string | null => {
  if (value === null) return null;
  const characters = [...value];
  return characters.length <= PREVIEW_MAX_LENGTH
    ? value
    : `${characters.slice(0, PREVIEW_MAX_LENGTH - 1).join('')}…`;
};

@Injectable()
export class NotificationsService {
  public constructor(
    @Inject(NOTIFICATION_STORE) private readonly store: NotificationStore,
    @Inject(REALTIME_HUB) private readonly hub: RealtimeHub,
    @Inject(IDS) private readonly ids: IdGenerator,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * Records a notification if the domain rules allow it.
   *
   * Returns the stored row, or null when nothing was written. Callers use the
   * return value only for tests and logging; a producer must not branch on it.
   */
  public async notify(input: NotifyInput): Promise<NotificationView | null> {
    const decision = decideNotification({
      kind: input.kind,
      actorId: input.actorId,
      recipientId: input.recipientId,
      blocked: input.context.blocked,
      entitled: input.context.entitled,
    });

    if (!decision.notify) {
      this.logger.event('debug', 'notifications.skipped', {
        kind: input.kind,
        reason: decision.reason,
        recipientId: input.recipientId,
      });
      return null;
    }

    const written = await this.store
      .upsert({
        id: this.ids.next(),
        recipientId: input.recipientId,
        kind: decision.kind,
        actorId: input.actorId,
        groupKey: input.groupKey,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        preview: truncate(input.preview),
      })
      .catch((error: unknown) => {
        // Delivery of a like must not fail because the badge could not be written.
        this.logger.event('error', 'notifications.write_failed', {
          kind: input.kind,
          recipientId: input.recipientId,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

    if (written === null) return null;

    const view = toView(written);
    this.hub.publish(input.recipientId, { type: 'notification', notification: view });

    // The badge is pushed with every frame so a client never has to poll to keep
    // it honest, and never has to count rows it has not loaded.
    const unread = await this.store.unreadCount(input.recipientId).catch(() => null);
    if (unread !== null) {
      this.hub.publish(input.recipientId, {
        type: 'unread',
        unreadCount: unread,
        badge: unreadBadge(unread),
      });
    }

    return view;
  }

  /**
   * Notifies everyone mentioned in a body.
   *
   * Usernames come from the text, resolved by the caller, and the actor is always
   * excluded — mentioning yourself is not a notification. Each recipient's block
   * relationship is checked by the caller through `contextFor`, because that fact
   * lives in the profile module and duplicating the query here would be a second
   * definition of "blocked".
   */
  public async notifyMentions(input: {
    readonly body: string;
    readonly actorId: string;
    readonly subjectType: NotificationSubjectType;
    readonly subjectId: string;
    readonly resolve: (username: string) => Promise<string | null>;
    readonly contextFor: (recipientId: string) => Promise<NotificationContext>;
  }): Promise<number> {
    const usernames = extractMentions(input.body);
    let sent = 0;

    for (const username of usernames) {
      const recipientId = await input.resolve(username);
      if (recipientId === null || recipientId === input.actorId) continue;

      const context = await input.contextFor(recipientId);
      const written = await this.notify({
        kind: 'MENTION',
        recipientId,
        actorId: input.actorId,
        // A mention collapses per subject: ten mentions of you in one thread is one
        // notification, because the thread is what you would act on.
        groupKey: `mention:${input.subjectId}`,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        preview: input.body,
        context,
      });
      if (written !== null) sent += 1;
    }

    return sent;
  }

  public async list(
    recipientId: string,
    page: { limit: number; cursor: string | null; unreadOnly: boolean },
  ): Promise<NotificationListView> {
    const result = await this.store.list({ recipientId, ...page });
    return {
      items: result.items.map(toView),
      nextCursor: result.hasMore ? (result.items[result.items.length - 1]?.id ?? null) : null,
      unreadCount: result.unreadCount,
    };
  }

  public async summary(
    recipientId: string,
  ): Promise<{ unreadCount: number; badge: string; badgeCap: number }> {
    const count = await this.store.unreadCount(recipientId);
    // Read with the cap applied on the server so every surface agrees on "99+".
    return { unreadCount: count, badge: unreadBadge(count), badgeCap: 99 };
  }

  public async markRead(
    recipientId: string,
    notificationId: string,
  ): Promise<{ unreadCount: number }> {
    const changed = await this.store.markRead(recipientId, notificationId);
    // Someone else's notification is reported as missing, not forbidden: the same
    // rule the feed applies to a post the viewer cannot see.
    if (!changed) throw new DomainException(appError('NOT_FOUND', 'Notification not found'));

    const unreadCount = await this.store.unreadCount(recipientId);
    this.hub.publish(recipientId, {
      type: 'unread',
      unreadCount,
      badge: unreadBadge(unreadCount),
    });
    return { unreadCount };
  }

  public async markAllRead(recipientId: string): Promise<{ unreadCount: number }> {
    await this.store.markAllRead(recipientId);
    this.hub.publish(recipientId, { type: 'unread', unreadCount: 0, badge: unreadBadge(0) });
    return { unreadCount: 0 };
  }
}

export const toView = (record: NotificationRecord): NotificationView => ({
  id: record.id,
  kind: record.kind,
  actors: record.actors,
  actorCount: record.actorCount,
  preview: record.preview,
  subjectType: record.subjectType,
  subjectId: record.subjectId,
  read: record.read,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});
