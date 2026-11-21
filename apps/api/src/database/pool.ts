/**
 * Postgres access layer.
 *
 * One `pg.Pool` per database endpoint, created lazily and shared for the life of
 * the process. A pool is a scarce, expensive resource: creating one per request
 * exhausts connections and defeats PgBouncer, and creating one per repository
 * multiplies the connection budget by the number of modules.
 *
 * The shard router resolves a user to a `ShardLocation`; this class maps that
 * location to a pool. In single-shard development every location points at the
 * same DSN, so the routing logic is exercised from day one without extra
 * infrastructure.
 */

import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { JsonLogger } from '../common/logging/logger.js';

export type Queryable = {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
};

@Injectable()
export class DatabasePools implements OnApplicationShutdown {
  private readonly pools = new Map<string, Pool>();

  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  public pool(dsn: string = this.env.DATABASE_URL): Pool {
    const existing = this.pools.get(dsn);
    if (existing !== undefined) return existing;

    const pool = new Pool({
      connectionString: dsn,
      max: this.env.DATABASE_POOL_MAX,
      // Fail fast instead of queueing behind a saturated server: a request that
      // waits 30s for a connection has already failed for the user.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      // A hung server-side statement must not pin a connection indefinitely.
      statement_timeout: 10_000,
      query_timeout: 10_000,
      application_name: this.env.APP_NAME,
      ...(this.env.DATABASE_SSL ? { ssl: { rejectUnauthorized: true } } : {}),
    });

    pool.on('error', (error: Error) => {
      // Idle-client errors surface here; without a listener the process crashes.
      this.logger.event('error', 'db.pool.error', { message: error.message });
    });

    this.pools.set(dsn, pool);
    return pool;
  }

  /** Runs a function inside a transaction, rolling back on any throw. */
  public async transaction<T>(run: (client: PoolClient) => Promise<T>, dsn?: string): Promise<T> {
    const client = await this.pool(dsn).connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.end()));
    this.pools.clear();
  }
}
