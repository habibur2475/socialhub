/**
 * Cache module.
 *
 * Global for the same reason as the database module: the Redis connection and the
 * selected adapter must be process-wide. A per-module provider would open a
 * second socket and, worse, a second `MemoryCache` in tests — making rate limits
 * and permission invalidation module-local without anything failing loudly.
 */

import { Global, Module } from '@nestjs/common';

import { ConfigModule } from '../config/config.module.js';
import { RedisConnection } from './redis.js';
import { CACHE, cacheProvider } from './cache.provider.js';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisConnection, cacheProvider],
  exports: [CACHE, RedisConnection],
})
export class CacheModule {}
