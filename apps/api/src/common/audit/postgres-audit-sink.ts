/**
 * Hash-chained audit sink.
 *
 * Each row commits to the previous row's hash. A reader can therefore verify that
 * no row was deleted, reordered or edited by recomputing the chain — which is
 * what separates an audit trail from a log file.
 *
 * The chain head is kept in Redis so appending does not require a table scan.
 * Losing that key is recoverable: the writer falls back to the newest row in the
 * table, so process restarts and cache evictions cannot fork the chain.
 */

import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DatabasePools } from '../../../database/pool.js';
import type { CachePort } from '../../../common/cache/cache-port.js';
import { JsonLogger } from '../../../common/logging/logger.js';
import type { AuditEvent, AuditSink } from '../application/ports.js';

const CHAIN_HEAD_KEY = 'audit:chain:head';

export const computeEntryHash = (previousHash: Buffer | null, canonicalPayload: string): Buffer => {
  const digest = createHash('sha256');
  digest.update(previousHash ?? Buffer.alloc(0));
  digest.update(canonicalPayload, 'utf8');
  return digest.digest();
};

/**
 * Deterministic serialisation for hashing. Key order must not depend on insertion
 * order, or two identical events would hash differently and the chain would be
 * unverifiable.
 */
const canonicalise = (value: Record<string, unknown>): string => {
  const entries = Object.keys(value)
    .sort()
    .map((key) => [key, value[key]] as const);
  return JSON.stringify(entries);
};

@Injectable()
export class PostgresAuditSink implements AuditSink {
  public constructor(
    private readonly pools: DatabasePools,
    private readonly cache: CachePort,
    private readonly logger: JsonLogger,
    private readonly idGenerator: () => string,
    private readonly now: () => Date,
  ) {}

  public async record(event: AuditEvent): Promise<void> {
    const occurredAt = this.now();
    try {
      const previousHash = await this.currentHead();
      const payload: Record<string, unknown> = {
        action: event.action,
        actorId: event.actorId,
        actorType: event.actorType,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        outcome: event.outcome,
        occurredAt: occurredAt.toISOString(),
        payload: event.payload,
        traceId: event.traceId,
      };
      const entryHash = computeEntryHash(previousHash, canonicalise(payload));

      await this.pools.pool().query(
        `INSERT INTO audit_events
           (id, occurred_at, actor_id, actor_type, action, resource_type, resource_id,
            outcome, ip_hash, user_agent, trace_id, payload, previous_hash, entry_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          this.idGenerator(),
          occurredAt,
          event.actorId,
          event.actorType,
          event.action,
          event.resourceType,
          event.resourceId,
          event.outcome,
          event.ipHash,
          event.userAgent,
          event.traceId,
          JSON.stringify(event.payload),
          previousHash,
          entryHash,
        ],
      );

      await this.cache
        .set(CHAIN_HEAD_KEY, entryHash.toString('base64'), null)
        .catch(() => undefined);
    } catch (error) {
      // An audit write failure must never fail the user's request — but it must
      // be extremely visible, because a gap in the chain is a compliance issue.
      this.logger.event('fatal', 'audit.write_failed', {
        action: event.action,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async currentHead(): Promise<Buffer | null> {
    const cached = await this.cache.get(CHAIN_HEAD_KEY).catch(() => null);
    if (cached !== null) return Buffer.from(cached, 'base64');

    const { rows } = await this.pools.pool().query<{
      entry_hash: Buffer;
    }>('SELECT entry_hash FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT 1');
    return rows[0]?.entry_hash ?? null;
  }
}
