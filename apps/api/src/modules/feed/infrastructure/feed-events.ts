/**
 * Feed → notification adapter.
 *
 * This is the only place that knows a liked post becomes a notification row. The
 * feed emits a domain event; this adapter translates it into the two facts the
 * notification decision needs — is there a block between the accounts, and is the
 * recipient entitled to know — and hands it to the notification service.
 *
 * Why the adapter and not the feed service: entitlement is a *relationship*
 * question, and answering it inside the feed would duplicate the social-graph
 * query and the block rule that the profile module already owns.
 *
 * Why fire-and-forget: `emit` never throws. A like that succeeded but could not be
 * announced is a missing badge; a like reported as failed when it was stored is a
 * duplicate the user creates on retry.
 */

import { Inject, Injectable } from '@nestjs/common';

import { JsonLogger } from '../../../common/logging/logger.js';
import type { ProfileStore, SocialGraphStore } from '../../profile/application/ports.js';
import { PROFILE_STORE, SOCIAL_GRAPH_STORE } from '../../profile/profile.tokens.js';
import type { NotificationsService } from '../../notifications/application/notifications.service.js';
import { NOTIFICATION_SERVICE } from '../../notifications/notifications.tokens.js';
import type { FeedEvent, FeedEvents } from '../application/ports.js';

@Injectable()
export class FeedEventAdapter implements FeedEvents {
  public constructor(
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: NotificationsService,
    @Inject(PROFILE_STORE) private readonly profiles: ProfileStore,
    @Inject(SOCIAL_GRAPH_STORE) private readonly graph: SocialGraphStore,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  public async emit(event: FeedEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'POST_LIKED':
          await this.notifications.notify({
            kind: 'LIKE',
            recipientId: event.authorId,
            actorId: event.actorId,
            // Collapses per post: ten likes on one post are one row.
            groupKey: `like:${event.postId}`,
            subjectType: 'post',
            subjectId: event.postId,
            preview: event.preview,
            context: await this.contextFor(event.authorId, event.actorId),
          });
          return;

        case 'POST_REPLIED':
          await this.notifications.notify({
            kind: 'REPLY',
            recipientId: event.parentAuthorId,
            actorId: event.actorId,
            groupKey: `reply:${event.postId}`,
            subjectType: 'post',
            subjectId: event.postId,
            preview: event.body,
            context: await this.contextFor(event.parentAuthorId, event.actorId),
          });
          // A reply body can also mention people; those are separate notifications
          // because the recipient and the subject differ.
          await this.notifications.notifyMentions({
            body: event.body,
            actorId: event.actorId,
            subjectType: 'post',
            subjectId: event.postId,
            resolve: (username) => this.resolveAccount(username),
            contextFor: (recipientId) => this.contextFor(recipientId, event.actorId),
          });
          return;

        case 'POST_PUBLISHED':
          // A new post notifies nobody by publication; only mentions can.
          await this.notifications.notifyMentions({
            body: event.body,
            actorId: event.actorId,
            subjectType: 'post',
            subjectId: event.postId,
            resolve: (username) => this.resolveAccount(username),
            contextFor: (recipientId) => this.contextFor(recipientId, event.actorId),
          });
          return;
      }
    } catch (error) {
      // Never propagate: see the module comment.
      this.logger.event('error', 'feed.notification_failed', {
        eventType: event.type,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The facts `decideNotification` needs.
   *
   * `entitled` is true unless a block exists: every recipient here is either the
   * author of the subject or someone mentioned in it, and both are entitled by
   * construction. The block check is what can still deny.
   */
  private async contextFor(
    recipientId: string,
    actorId: string,
  ): Promise<{ blocked: boolean; entitled: boolean }> {
    const blocked = await this.graph.isBlockedEitherWay(recipientId, actorId);
    return { blocked, entitled: !blocked };
  }

  /**
   * Resolves a username to an account id.
   *
   * Unknown usernames are null, not an error: a post that says "email me at
   * @your_support" mentions something that may not be an account at all.
   */
  private async resolveAccount(username: string): Promise<string | null> {
    const profile = await this.profiles.findByUsername(username);
    return profile === null ? null : profile.accountId;
  }
}
