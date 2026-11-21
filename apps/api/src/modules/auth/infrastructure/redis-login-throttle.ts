/**
 * Credential throttling.
 *
 * Two budgets are enforced per attempt, and both must allow it:
 *   * identity budget — stops targeted password guessing against one account;
 *   * source budget   — stops credential stuffing that rotates accounts.
 *
 * Policy on cache failure is fail-open with a loud log. The alternative is that a
 * cache outage locks every user out of the product, which is a worse outcome than
 * degrading to the gateway's coarse per-IP limit. The decision is centralised
 * here so it is reviewable in one place.
 */

import { Injectable } from '@nestjs/common';

import { JsonLogger } from '../../../common/logging/logger.js';
import type { CachePort } from '../../../common/cache/cache-port.js';
import type { LoginThrottle } from '../application/ports.js';

export type ThrottleOptions = {
  readonly identityLimit: number;
  readonly identityWindowMs: number;
  readonly sourceLimit: number;
  readonly sourceWindowMs: number;
  readonly prefix: string;
};

@Injectable()
export class LoginThrottleService implements LoginThrottle {
  public constructor(
    private readonly cache: CachePort,
    private readonly logger: JsonLogger,
    private readonly options: ThrottleOptions,
  ) {}

  public async tryConsume(key: string): Promise<boolean> {
    const member = `${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    try {
      const identityAllowed = await this.cache.allowInSlidingWindow(
        `${this.options.prefix}:identity:${key}`,
        this.options.identityLimit,
        this.options.identityWindowMs,
        member,
      );
      if (!identityAllowed) return false;

      return await this.cache.allowInSlidingWindow(
        `${this.options.prefix}:source:${key}`,
        this.options.sourceLimit,
        this.options.sourceWindowMs,
        member,
      );
    } catch (error) {
      this.logger.event('error', 'throttle.unavailable', {
        message: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  public async reset(key: string): Promise<void> {
    try {
      await this.cache.clearSlidingWindow(`${this.options.prefix}:identity:${key}`);
    } catch (error) {
      this.logger.event('warn', 'throttle.reset_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
