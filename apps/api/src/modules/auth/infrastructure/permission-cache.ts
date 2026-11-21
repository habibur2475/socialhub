/**
 * Permission resolution.
 *
 * The hot path of an authorization check must not touch the database. This
 * service aggregates a principal's role grants into one mask and caches it in
 * Redis, keyed by account id and invalidated by a version counter that role
 * changes bump.
 *
 * Cache strategy: cache-aside with a short TTL plus explicit invalidation.
 *   * TTL (5 min) bounds staleness if an invalidation message is lost.
 *   * Explicit `invalidate(accountId)` makes revocation immediate for the
 *     common case (an admin changes someone's role).
 *   * On Redis failure the service falls back to the database. Authorization
 *     must not fail open, so a cache outage degrades latency, not correctness.
 */

import { Inject, Injectable } from '@nestjs/common';
import { type Permission, PermissionMask, isPermission } from '@socialhub/kernel';

import { DatabasePools } from '../../../database/pool.js';
import type { CachePort } from '../../../common/cache/cache-port.js';
import { JsonLogger } from '../../../common/logging/logger.js';
import { CACHE } from '../../../database/cache.provider.js';

const TTL_SECONDS = 300;
const keyFor = (accountId: string): string => `perm:v1:${accountId}`;

export type CachedPermissions = {
  readonly mask: PermissionMask;
  /** Scope ids the grants are attached to; empty for external users. */
  readonly scopes: readonly string[];
};

@Injectable()
export class PermissionCache {
  public constructor(
    @Inject(DatabasePools) private readonly pools: DatabasePools,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {}

  /**
   * Returns the aggregated permission set for an account.
   *
   * Aggregation semantics: a role contributes the union of its
   * `role_permissions` rows. Expired grants are excluded at query time rather
   * than by a background sweep, so a lapsed delegation stops working at the
   * stated instant even if the sweeper is down.
   */
  public async resolve(accountId: string): Promise<CachedPermissions> {
    const cached = await this.readCache(accountId);
    if (cached !== null) return cached;

    const resolved = await this.loadFromDatabase(accountId);
    await this.writeCache(accountId, resolved);
    return resolved;
  }

  public async invalidate(accountId: string): Promise<void> {
    try {
      await this.cache.del(keyFor(accountId));
    } catch (error) {
      this.logger.event('warn', 'permission.invalidate_failed', {
        accountId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Invalidates every cached entry for accounts holding the given role. */
  public async invalidateRole(roleId: string): Promise<number> {
    const { rows } = await this.pools.pool().query<{
      account_id: string;
    }>('SELECT DISTINCT account_id FROM user_roles WHERE role_id = $1', [roleId]);
    await Promise.all(rows.map((row) => this.invalidate(row.account_id)));
    return rows.length;
  }

  private async readCache(accountId: string): Promise<CachedPermissions | null> {
    try {
      const raw = await this.cache.get(keyFor(accountId));
      if (raw === null) return null;
      return deserialise(raw);
    } catch {
      return null;
    }
  }

  private async writeCache(accountId: string, permissions: CachedPermissions): Promise<void> {
    try {
      await this.cache.set(keyFor(accountId), serialise(permissions), TTL_SECONDS);
    } catch (error) {
      this.logger.event('warn', 'permission.cache_write_failed', {
        accountId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async loadFromDatabase(accountId: string): Promise<CachedPermissions> {
    const { rows } = await this.pools
      .pool()
      .query<{ permission_key: string; scope_id: string | null }>(
        `SELECT rp.permission_key, ur.scope_id
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.account_id = $1
          AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
        [accountId],
      );

    const grants: Permission[] = [];
    const scopes = new Set<string>();
    for (const row of rows) {
      if (isPermission(row.permission_key)) grants.push(row.permission_key);
      if (row.scope_id !== null) scopes.add(row.scope_id);
    }

    return { mask: PermissionMask.fromList(grants), scopes: [...scopes] };
  }
}

type Serialised = { readonly m: string; readonly s: readonly string[] };

const serialise = (permissions: CachedPermissions): string => {
  const payload: Serialised = { m: permissions.mask.toString(), s: permissions.scopes };
  return JSON.stringify(payload);
};

const deserialise = (raw: string): CachedPermissions | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('m' in parsed) ||
      !('s' in parsed) ||
      typeof (parsed as Serialised).m !== 'string' ||
      !Array.isArray((parsed as Serialised).s)
    ) {
      return null;
    }
    const mask = PermissionMask.fromString((parsed as Serialised).m);
    if (mask === null) return null;
    return { mask, scopes: (parsed as Serialised).s.filter((scope) => typeof scope === 'string') };
  } catch {
    return null;
  }
};
