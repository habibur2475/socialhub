/**
 * Redis cache adapter.
 *
 * Two scripts, both atomic:
 *   * `SET key value EX ttl` for plain caching.
 *   * A sorted-set sliding window for rate limiting. Doing this server-side is
 *     what makes it correct across instances: two API pods share one budget.
 *
 * Failures are reported to the caller rather than swallowed. The caller decides
 * the policy (login throttling fails open, permission reads fall back to the
 * database) because only the caller knows the cost of being wrong.
 */

import type { Redis } from 'ioredis';

import type { CachePort } from './cache-port.js';

/**
 * Exact sliding window, evaluated in one round trip.
 * KEYS[1] = window key, ARGV = now(ms), window(ms), limit, member
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
if redis.call('ZCARD', key) >= limit then
  redis.call('PEXPIRE', key, window)
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return 1
`;

export class RedisCache implements CachePort {
  public constructor(
    private readonly client: Redis,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  public async set(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    if (ttlSeconds === null) {
      await this.client.set(key, value);
      return;
    }
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  public async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  public async allowInSlidingWindow(
    key: string,
    limit: number,
    windowMs: number,
    member: string,
  ): Promise<boolean> {
    const result = await this.client.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      key,
      this.now().toString(),
      windowMs.toString(),
      limit.toString(),
      member,
    );
    return result === 1;
  }

  public async clearSlidingWindow(key: string): Promise<void> {
    await this.client.del(key);
  }

  public async ping(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }
}
