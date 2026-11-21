/**
 * Notifications module composition.
 *
 * `REALTIME_HUB` is provided *as the concrete class* and then aliased to the port
 * token. The controller needs the class to open a stream; every producer needs the
 * port to publish. One instance, two names — a `useClass` binding for the port
 * would construct a second hub whose subjects nobody is subscribed to.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { JsonLogger } from '../../common/logging/logger.js';
import { NotificationsService } from './application/notifications.service.js';
import { PostgresNotificationRepository } from './infrastructure/notification.repository.js';
import { InProcessRealtimeHub } from './infrastructure/realtime-hub.js';
import { NotificationsController } from './presentation/notifications.controller.js';
import { NOTIFICATION_SERVICE, NOTIFICATION_STORE, REALTIME_HUB } from './notifications.tokens.js';
import type { NotificationStore, RealtimeHub } from './application/ports.js';
import { IDS } from '../auth/auth.tokens.js';
import type { IdGenerator } from '../auth/application/ports.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [NotificationsController],
  providers: [
    { provide: NOTIFICATION_STORE, useClass: PostgresNotificationRepository },
    InProcessRealtimeHub,
    { provide: REALTIME_HUB, useExisting: InProcessRealtimeHub },
    {
      provide: NOTIFICATION_SERVICE,
      useFactory: (
        store: NotificationStore,
        hub: RealtimeHub,
        ids: IdGenerator,
        logger: JsonLogger,
      ): NotificationsService => new NotificationsService(store, hub, ids, logger),
      inject: [NOTIFICATION_STORE, REALTIME_HUB, IDS, JsonLogger],
    },
  ],
  // Exported so the feed, quiz and forum modules can produce notifications
  // without owning a second repository or a second decision path.
  exports: [NOTIFICATION_SERVICE, REALTIME_HUB],
})
export class NotificationsModule {}
