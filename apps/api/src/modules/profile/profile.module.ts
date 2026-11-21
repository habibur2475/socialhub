/**
 * Profile module composition.
 *
 * The social graph depends on nothing from auth but the shared audit sink and the
 * guard, both of which `AuthModule` exports. Keeping that dependency one-way
 * means the auth module can be extracted into its own service without the profile
 * module moving with it.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../../common/audit/audit.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { ProfileService } from './application/profile.service.js';
import { PostgresProfileRepository } from './infrastructure/profile.repository.js';
import { PostgresSocialGraphRepository } from './infrastructure/social-graph.repository.js';
import { ProfileController } from './presentation/profile.controller.js';
import { PROFILE_SERVICE, PROFILE_STORE, SOCIAL_GRAPH_STORE } from './profile.tokens.js';
import { AUDIT_SINK } from '../../common/audit/audit.tokens.js';
import type { AuditSink } from '../../common/audit/audit.port.js';
import type { ProfileStore, SocialGraphStore } from './application/ports.js';

@Module({
  imports: [AuthModule, AuditModule, DatabaseModule],
  controllers: [ProfileController],
  providers: [
    { provide: PROFILE_STORE, useClass: PostgresProfileRepository },
    { provide: SOCIAL_GRAPH_STORE, useClass: PostgresSocialGraphRepository },
    {
      provide: PROFILE_SERVICE,
      // Constructed explicitly so every dependency is visible in one place and
      // ordered by the type system, rather than inferred from decorator metadata
      // that esbuild does not emit.
      useFactory: (
        profiles: ProfileStore,
        graph: SocialGraphStore,
        audit: AuditSink,
      ): ProfileService => new ProfileService(profiles, graph, audit),
      inject: [PROFILE_STORE, SOCIAL_GRAPH_STORE, AUDIT_SINK],
    },
  ],
  // PROFILE_STORE is exported so the feed module can resolve a username to an
  // account id without owning a second query against user_profiles.
  exports: [PROFILE_SERVICE, PROFILE_STORE],
})
export class ProfileModule {}
