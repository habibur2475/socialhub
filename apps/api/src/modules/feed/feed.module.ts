/**
 * Feed module composition.
 *
 * Depends on `AuthModule` for the guard and id generator and on `ProfileModule`
 * for the username lookup. Post reads and writes stay inside this module, so
 * splitting the read path into its own service later is a move of one adapter.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { IDS } from '../auth/auth.tokens.js';
import type { IdGenerator } from '../auth/application/ports.js';
import { FeedService } from './application/feed.service.js';
import { PostgresPostRepository } from './infrastructure/post.repository.js';
import { FeedController } from './presentation/feed.controller.js';
import { FEED_SERVICE, POST_STORE } from './feed.tokens.js';
import type { FeedEvents, PostStore } from './application/ports.js';
import { FeedEventAdapter } from './infrastructure/feed-events.js';

@Module({
  imports: [AuthModule, ProfileModule, NotificationsModule, DatabaseModule],
  controllers: [FeedController],
  providers: [
    { provide: POST_STORE, useClass: PostgresPostRepository },
    FeedEventAdapter,
    {
      provide: FEED_SERVICE,
      // Constructed explicitly: every dependency is visible here, and the order is
      // checked by the type system rather than inferred from decorator metadata.
      useFactory: (posts: PostStore, ids: IdGenerator, events: FeedEvents): FeedService =>
        new FeedService(posts, ids, events),
      inject: [POST_STORE, IDS, FeedEventAdapter],
    },
  ],
  exports: [FEED_SERVICE],
})
export class FeedModule {}
