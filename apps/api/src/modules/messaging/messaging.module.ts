/**
 * Messaging module composition.
 *
 * The module borrows two providers instead of owning copies of them:
 *
 *   REALTIME_HUB    the SSE hub the notification stream already serves, so a message
 *                   arrives on the connection the browser has open.
 *   IDS             uuidv7 generators, so message ids are time-ordered.
 *
 * It deliberately does not depend on `NotificationsService`: a conversation is its own
 * inbox, and a notification row per message would duplicate it.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { JsonLogger } from '../../common/logging/logger.js';
import { IDS } from '../auth/auth.tokens.js';
import type { IdGenerator } from '../auth/application/ports.js';
import type { RealtimeHub } from '../notifications/application/ports.js';
import { REALTIME_HUB } from '../notifications/notifications.tokens.js';
import { MessagingService } from './application/messaging.service.js';
import { PostgresConversationRepository } from './infrastructure/conversation.repository.js';
import { MessagingController } from './presentation/messaging.controller.js';
import { CONVERSATION_STORE, MESSAGING_SERVICE } from './messaging.tokens.js';
import type { ConversationStore } from './application/ports.js';

@Module({
  imports: [AuthModule, NotificationsModule, DatabaseModule],
  controllers: [MessagingController],
  providers: [
    { provide: CONVERSATION_STORE, useClass: PostgresConversationRepository },
    {
      provide: MESSAGING_SERVICE,
      useFactory: (
        store: ConversationStore,
        hub: RealtimeHub,
        ids: IdGenerator,
        logger: JsonLogger,
      ): MessagingService => new MessagingService(store, hub, ids, logger),
      inject: [CONVERSATION_STORE, REALTIME_HUB, IDS, JsonLogger],
    },
  ],
  exports: [MESSAGING_SERVICE],
})
export class MessagingModule {}
