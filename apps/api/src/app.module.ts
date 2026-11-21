/**
 * Root module.
 *
 * Modular monolith: features are modules with explicit exports, so extracting a
 * module into its own service later means moving a directory and replacing an
 * in-process call with an RPC client — the boundaries already exist.
 */

import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { ConfigModule } from './config/config.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { ProfileModule } from './modules/profile/profile.module.js';

@Module({
  imports: [
    ConfigModule,
    ThrottlerModule.forRoot([
      // Baseline protection for every route. Credential endpoints add their own
      // identity-aware throttle on top, because IP limits are trivially bypassed
      // by a distributed attacker.
      { name: 'burst', ttl: 1_000, limit: 20 },
      { name: 'sustained', ttl: 60_000, limit: 300 },
    ]),
    AuthModule,
    ProfileModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
