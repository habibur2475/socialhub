/**
 * Audit module composition.
 *
 * Exported as a module so a feature module can declare its dependency on the
 * audit capability in one line: `imports: [AuditModule]`. The provider graph
 * inside is explicit, as everywhere else in this codebase.
 */

import { Global, Module } from '@nestjs/common';

import { CLOCK } from '../ids/clock.tokens.js';
import { systemClock, uuidv7Identifiers } from '../ids/system-clock.js';
import { JsonLogger } from '../logging/logger.js';
import { DatabasePools } from '../../database/pool.js';
import { CACHE } from '../../database/cache.provider.js';
import type { CachePort } from '../cache/cache-port.js';
import { AUDIT_SINK } from './audit.tokens.js';
import { PostgresAuditSink } from './postgres-audit-sink.js';
import type { AuditSink } from './audit.port.js';

/**
 * Global: every module that performs a consequential action needs to record it,
 * and they all share one hash chain. A second sink instance would maintain a
 * second head pointer and fork the chain.
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useValue: (): Date => systemClock.now() },
    {
      provide: AUDIT_SINK,
      useFactory: (
        pools: DatabasePools,
        cache: CachePort,
        logger: JsonLogger,
        clock: () => Date,
      ): AuditSink => new PostgresAuditSink(pools, cache, logger, uuidv7Identifiers.next, clock),
      inject: [DatabasePools, CACHE, JsonLogger, CLOCK],
    },
  ],
  // CLOCK is exported because it is registered here and consumed by the token
  // issuer; a global module only shares what it explicitly exports.
  exports: [AUDIT_SINK, CLOCK],
})
export class AuditModule {}
