/**
 * Market module composition.
 *
 * Two controllers because listings and orders are read by different people: the shopfront is
 * public to every signed-in account, while an order is visible to exactly two of them.
 *
 * There is no dependency on `NotificationsService`. An order changing state is something the
 * buyer opens the app to check; a notification for every move would be a bell that rings for
 * the courier's schedule rather than for anything the buyer did.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { CLOCK, IDS } from '../auth/auth.tokens.js';
import type { Clock, IdGenerator } from '../auth/application/ports.js';
import { MarketService } from './application/market.service.js';
import { PostgresListingStore } from './infrastructure/listing.repository.js';
import { PostgresOrderStore } from './infrastructure/order.repository.js';
import { ListingController, OrderController } from './presentation/market.controller.js';
import { LISTING_STORE, MARKET_SERVICE, ORDER_STORE } from './market.tokens.js';
import type { ListingStore, OrderStore } from './application/ports.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ListingController, OrderController],
  providers: [
    { provide: LISTING_STORE, useClass: PostgresListingStore },
    { provide: ORDER_STORE, useClass: PostgresOrderStore },
    {
      provide: MARKET_SERVICE,
      useFactory: (listings: ListingStore, orders: OrderStore, ids: IdGenerator, clock: Clock) =>
        new MarketService(listings, orders, ids, clock),
      inject: [LISTING_STORE, ORDER_STORE, IDS, CLOCK],
    },
  ],
  exports: [MARKET_SERVICE],
})
export class MarketModule {}
