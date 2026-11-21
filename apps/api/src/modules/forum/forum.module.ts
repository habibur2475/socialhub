/**
 * Forum module composition.
 *
 * The forum resolves usernames through `PROFILE_STORE` and blocks through
 * `SOCIAL_GRAPH_STORE` rather than owning those queries: mention resolution and the
 * block rule already have exactly one implementation each, and a forum-local copy
 * would be a second one that can disagree.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { IDS } from '../auth/auth.tokens.js';
import type { IdGenerator } from '../auth/application/ports.js';
import type { ProfileStore, SocialGraphStore } from '../profile/application/ports.js';
import { PROFILE_STORE, SOCIAL_GRAPH_STORE } from '../profile/profile.tokens.js';
import type { NotificationsService } from '../notifications/application/notifications.service.js';
import { NOTIFICATION_SERVICE } from '../notifications/notifications.tokens.js';
import { ForumService } from './application/forum.service.js';
import { PostgresForumRepository } from './infrastructure/forum.repository.js';
import { ForumController } from './presentation/forum.controller.js';
import { FORUM_SERVICE, FORUM_STORE } from './forum.tokens.js';
import type { ForumStore } from './application/ports.js';

@Module({
  imports: [AuthModule, ProfileModule, NotificationsModule, DatabaseModule],
  controllers: [ForumController],
  providers: [
    { provide: FORUM_STORE, useClass: PostgresForumRepository },
    {
      provide: FORUM_SERVICE,
      useFactory: (
        forum: ForumStore,
        notifications: NotificationsService,
        profiles: ProfileStore,
        graph: SocialGraphStore,
        ids: IdGenerator,
      ): ForumService => new ForumService(forum, notifications, profiles, graph, ids),
      inject: [FORUM_STORE, NOTIFICATION_SERVICE, PROFILE_STORE, SOCIAL_GRAPH_STORE, IDS],
    },
  ],
  exports: [FORUM_SERVICE],
})
export class ForumModule {}
