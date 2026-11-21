/**
 * Cache provider selection.
 *
 * `REDIS_URL` decides which adapter backs the `CachePort`. An explicit
 * `CACHE_DRIVER=memory` override exists for tests and for developers running the
 * API with no infrastructure; it is refused in production rather than silently
 * degrading, because a per-process cache would make rate limits and permission
 * invalidation wrong across replicas.
 */

import type { Provider } from '@nestjs/common';

import { MemoryCache } from '../common/cache/memory-cache.js';
import { RedisCache } from '../common/cache/redis-cache.js';
import { RedisConnection } from './redis.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export const CACHE = Symbol('CACHE');

export const cacheProvider: Provider = {
  provide: CACHE,
  useFactory: (env: Env, redis: RedisConnection): MemoryCache | RedisCache => {
    if (env.CACHE_DRIVER === 'memory') {
      if (env.NODE_ENV === 'production') {
        throw new Error('CACHE_DRIVER=memory is not permitted in production');
      }
      return new MemoryCache();
    }
    return new RedisCache(redis.client);
  },
  inject: [ENV, RedisConnection],
};
