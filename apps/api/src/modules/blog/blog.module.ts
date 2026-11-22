/**
 * Blog module composition.
 *
 * The module owns its store and borrows only the two primitives every write needs: the
 * uuidv7 generator and the clock. Both are re-exported by `AuthModule`, which is also
 * where the platform's audit sink lives — a blog has no audit needs of its own.
 *
 * There is no dependency on `NotificationsService`: publishing an article notifies
 * nobody. A blog is read, not subscribed to, and a "your favourite author published"
 * feature is a follow-the-author feature the feed already has the machinery for.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { CLOCK, IDS } from '../auth/auth.tokens.js';
import type { Clock, IdGenerator } from '../auth/application/ports.js';
import { BlogService } from './application/blog.service.js';
import { PostgresArticleRepository } from './infrastructure/article.repository.js';
import { BlogController } from './presentation/blog.controller.js';
import { ARTICLE_STORE, BLOG_SERVICE } from './blog.tokens.js';
import type { ArticleStore } from './application/ports.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [BlogController],
  providers: [
    { provide: ARTICLE_STORE, useClass: PostgresArticleRepository },
    {
      provide: BLOG_SERVICE,
      useFactory: (store: ArticleStore, ids: IdGenerator, clock: Clock): BlogService =>
        new BlogService(store, ids, clock),
      inject: [ARTICLE_STORE, IDS, CLOCK],
    },
  ],
  exports: [BLOG_SERVICE],
})
export class BlogModule {}
