/**
 * Branded primitive types.
 *
 * A brand is erased at runtime but prevents accidental interchange of two
 * structurally identical strings (a user id and a tenant id, a shard key and a
 * bucket index). Branding is applied only through the validating factories in
 * this module, so every branded value in the system has passed validation once.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type RoleId = Brand<string, 'RoleId'>;
export type PermissionId = Brand<string, 'PermissionId'>;
export type ScopeId = Brand<string, 'ScopeId'>;
export type ShardId = Brand<string, 'ShardId'>;
export type BucketId = Brand<number, 'BucketId'>;

/** UUIDv7 / UUIDv4 textual form, 8-4-4-4-12 lowercase hex. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

export const parseUserId = (value: string): UserId | null =>
  isUuid(value) ? (value as UserId) : null;

export const asUserId = (value: string): UserId => {
  if (!isUuid(value)) {
    throw new TypeError('UserId must be a canonical UUID');
  }
  return value as UserId;
};
