/**
 * Shard routing — deterministic, stable, reshardable.
 *
 * Routing is a pure function of the user id, so any service can compute the
 * location of a row without a lookup or a network hop:
 *
 *   UserId -> SHA-256 -> 4096 virtual buckets -> bucket table -> shard
 *
 * The virtual bucket indirection is what makes growth cheap. Adding a shard only
 * moves buckets in the metadata table; no key is ever re-hashed, so a reshard is
 * a sequence of background copies rather than a full re-keying of the corpus.
 */

import { createHash } from 'node:crypto';
import { type BucketId, type ShardId, asUserId } from './brand.js';
import { type Result, fail, ok } from './result.js';

export const VIRTUAL_BUCKET_COUNT = 4096;

export type ShardLocation = {
  readonly shardId: ShardId;
  readonly region: string;
  readonly primaryDsn: string;
  readonly replicaDsns: readonly string[];
};

export type ShardMapEntry = {
  readonly bucket: BucketId;
  readonly shard: ShardLocation;
};

export type ShardMap = {
  readonly version: number;
  readonly buckets: ReadonlyMap<number, ShardLocation>;
};

export type ShardingError =
  | { readonly code: 'INVALID_USER_ID'; readonly value: string }
  | { readonly code: 'UNMAPPED_BUCKET'; readonly bucket: number }
  | { readonly code: 'INVALID_BUCKET_ASSIGNMENT'; readonly detail: string };

/**
 * Stable hash of the user id onto a virtual bucket.
 *
 * SHA-256 is used rather than a rolling hash because the key set is adversarial:
 * ids are attacker-influenced in sign-up flows, and a weak hash lets an attacker
 * herd accounts onto a single shard to exhaust it.
 */
export const bucketForUser = (userId: string): Result<BucketId, ShardingError> => {
  const parsed = (() => {
    try {
      return asUserId(userId);
    } catch {
      return null;
    }
  })();
  if (parsed === null) return fail({ code: 'INVALID_USER_ID', value: userId });

  const digest = createHash('sha256').update(parsed, 'utf8').digest();
  // First 4 bytes are ample: 2^32 uniform outcomes folded onto 4096 buckets.
  const value = digest.readUInt32BE(0) % VIRTUAL_BUCKET_COUNT;
  return ok(value as BucketId);
};

export const buildShardMap = (
  entries: readonly ShardMapEntry[],
  version: number,
): Result<ShardMap, ShardingError> => {
  const buckets = new Map<number, ShardLocation>();
  for (const entry of entries) {
    if (
      !Number.isInteger(entry.bucket) ||
      entry.bucket < 0 ||
      entry.bucket >= VIRTUAL_BUCKET_COUNT
    ) {
      return fail({
        code: 'INVALID_BUCKET_ASSIGNMENT',
        detail: `bucket out of range: ${entry.bucket}`,
      });
    }
    if (buckets.has(entry.bucket)) {
      return fail({
        code: 'INVALID_BUCKET_ASSIGNMENT',
        detail: `duplicate bucket: ${entry.bucket}`,
      });
    }
    buckets.set(entry.bucket, entry.shard);
  }
  return ok({ version, buckets });
};

/** Resolves the shard that owns a user. Read replicas are selected by the caller. */
export const shardForUser = (
  userId: string,
  map: ShardMap,
): Result<ShardLocation, ShardingError> => {
  const bucket = bucketForUser(userId);
  if (!bucket.ok) return bucket;
  const location = map.buckets.get(bucket.value);
  if (location === undefined) return fail({ code: 'UNMAPPED_BUCKET', bucket: bucket.value });
  return ok(location);
};

/**
 * Distributes a shard count across buckets as evenly as integer arithmetic
 * allows, so a freshly created cluster is balanced before any resharding.
 */
export const evenBucketDistribution = (
  shards: readonly ShardLocation[],
): Result<readonly ShardMapEntry[], ShardingError> => {
  if (shards.length === 0) {
    return fail({ code: 'INVALID_BUCKET_ASSIGNMENT', detail: 'at least one shard is required' });
  }
  const entries: ShardMapEntry[] = [];
  for (let bucket = 0; bucket < VIRTUAL_BUCKET_COUNT; bucket += 1) {
    const shard = shards[bucket % shards.length];
    if (shard === undefined) {
      return fail({ code: 'INVALID_BUCKET_ASSIGNMENT', detail: 'shard lookup failed' });
    }
    entries.push({ bucket: bucket as BucketId, shard });
  }
  return ok(entries);
};

/** Co-location key for per-user tables; content tables derive theirs from the author. */
export const shardKeyForUser = (userId: string): string => `u:${userId}`;
