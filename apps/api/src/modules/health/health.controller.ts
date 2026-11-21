/**
 * Health endpoints.
 *
 * Two distinct contracts, deliberately kept apart:
 *   /health/live   — is this process able to serve? Never touches dependencies.
 *                    A failing dependency must not cause Kubernetes to kill the
 *                    pod; it should stop routing traffic, not restart workers.
 *   /health/ready  — can this instance serve real traffic? Checks the
 *                    dependencies it needs, with a short timeout.
 */

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type { Response } from 'express';

import { DatabasePools } from '../../database/pool.js';
import type { CachePort } from '../../common/cache/cache-port.js';
import { CACHE } from '../../database/cache.provider.js';
import { JsonLogger } from '../../common/logging/logger.js';

const STARTED_AT = Date.now();
const DEPENDENCY_TIMEOUT_MS = 1_000;

type CheckResult = { readonly ok: boolean; readonly latencyMs: number; readonly detail?: string };

const withTimeout = async (check: () => Promise<unknown>): Promise<CheckResult> => {
  const started = process.hrtime.bigint();
  try {
    await Promise.race([
      check(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('timeout')), DEPENDENCY_TIMEOUT_MS).unref(),
      ),
    ]);
    return { ok: true, latencyMs: Number((process.hrtime.bigint() - started) / 1_000_000n) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * `VERSION_NEUTRAL` is required alongside the global-prefix exclusion: URI
 * versioning would otherwise still insert `/v1` before an excluded path, which
 * would leave the probe at `/v1/health/live` instead of `/health/live`.
 */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  public constructor(
    @Inject(DatabasePools) private readonly pools: DatabasePools,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  public live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1_000) };
  }

  @Get('ready')
  public async ready(@Res({ passthrough: true }) response: Response): Promise<{
    status: 'ok' | 'degraded';
    checks: Record<string, CheckResult>;
  }> {
    const [database, cache] = await Promise.all([
      withTimeout(() => this.pools.pool().query('SELECT 1')),
      withTimeout(() => this.cache.ping()),
    ]);

    const ready = database.ok && cache.ok;
    if (!ready) {
      this.logger.event('warn', 'health.not_ready', { database, cache });
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return { status: ready ? 'ok' : 'degraded', checks: { database, cache } };
  }
}
