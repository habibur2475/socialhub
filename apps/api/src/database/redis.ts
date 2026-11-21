/**
 * Redis connectivity.
 *
 * Connections are created lazily, on first use. That matters for three reasons:
 *   * A process configured for the in-memory cache adapter never opens a socket,
 *     so development and test runs do not log reconnect storms.
 *   * Module wiring can declare the provider without paying for a connection
 *     during boot, which keeps startup fast and side-effect free.
 *   * A Redis outage surfaces where it is used (and is handled by the caller's
 *     policy) instead of crashing the process at import time.
 *
 * `maxRetriesPerRequest: 3` bounds a failing command instead of letting it hang
 * the request; reconnection backs off exponentially so a restarting server does
 * not receive a thundering herd.
 */

import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { JsonLogger } from '../common/logging/logger.js';

@Injectable()
export class RedisConnection implements OnApplicationShutdown {
  private instance: Redis | null = null;

  public constructor(
    @Inject(ENV) private readonly env: Pick<Env, 'REDIS_URL' | 'APP_NAME'>,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /** Returns the shared client, connecting on first call. */
  public get client(): Redis {
    if (this.instance !== null) return this.instance;

    const client = new Redis(this.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      connectionName: `${this.env.APP_NAME}:commands`,
      retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
      // Queued commands during an outage would pile up behind a dead socket;
      // failing fast lets the caller apply its own policy immediately.
      enableOfflineQueue: false,
      // Bound the initial connection attempt so a cold start cannot block boot.
      connectTimeout: 3_000,
    });

    client.on('error', (error: Error) => {
      this.logger.event('error', 'redis.error', { message: error.message });
    });
    client.on('reconnecting', () => {
      this.logger.event('warn', 'redis.reconnecting', {});
    });

    this.instance = client;
    return client;
  }

  public async onApplicationShutdown(): Promise<void> {
    const client = this.instance;
    this.instance = null;
    if (client === null) return;
    await client.quit().catch(() => client.disconnect());
  }
}
