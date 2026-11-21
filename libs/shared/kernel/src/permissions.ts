/**
 * Permission registry and mask algebra.
 *
 * Permissions are declared once, here, as `resource:action` pairs. Their index
 * in the registry *is* the bit position, so the mapping is compile-time constant,
 * deterministic across every service, and never recomputed at request time.
 *
 * The mask is an arbitrary-precision integer rather than a fixed 64-bit word.
 * JavaScript's bitwise operators silently truncate to 32 bits, so a single JS
 * number could never hold this safely — and the catalogue is already wider than
 * one machine word. Callers only ever use `has()`/`toWords()`; no call site is
 * coupled to the width, so the catalogue can grow without a migration.
 *
 * Persistence: Redis holds the canonical decimal string; Postgres holds the same
 * value as `numeric` (or `bytea` via `toWords`), both exact.
 */

export const PERMISSIONS = [
  // Platform administration
  'platform:read',
  'platform:manage',
  'platform:emergency_disable',
  'root:manage',
  // Identity and access
  'user:read',
  'user:manage',
  'user:suspend',
  'role:read',
  'role:manage',
  'permission:read',
  'permission:assign',
  // Organisational scope graph
  'org:read',
  'org:manage',
  'staff:read',
  'staff:manage',
  'staff:transfer',
  // HRMS
  'hr:read',
  'hr:manage',
  'payroll:read',
  'payroll:process',
  // Finance
  'wallet:read',
  'wallet:credit',
  'wallet:debit',
  'ledger:read',
  'ledger:post',
  'payout:read',
  'payout:approve',
  'revenue_split:read',
  'revenue_split:manage',
  'commission:read',
  'commission:manage',
  // Content
  'content:read',
  'content:create',
  'content:moderate',
  'content:delete',
  'comment:moderate',
  // Social feed
  'feed:read',
  'feed:curate',
  // Messaging
  'message:read',
  'message:moderate',
  // Quiz
  'quiz:read',
  'quiz:create',
  'quiz:moderate',
  // Forum
  'forum:read',
  'forum:post',
  'forum:moderate',
  // Blog
  'blog:read',
  'blog:write',
  'blog:publish',
  'blog:moderate',
  // Marketplace: e-commerce
  'product:read',
  'product:manage',
  'order:read',
  'order:fulfill',
  'order:refund',
  // Marketplace: freelance and jobs
  'job:read',
  'job:post',
  'job:moderate',
  'proposal:read',
  'proposal:submit',
  'contract:read',
  'contract:manage',
  // Advertising
  'ad:read',
  'ad:create',
  'ad:review',
  'ad:manage',
  'ad:analytics',
  // Tools and storage
  'tool:use',
  'file:upload',
  'file:manage',
  // Analytics and audit
  'analytics:read',
  'analytics:export',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_COUNT = PERMISSIONS.length;

/** Bits in one storage word; the unit of the `toWords` representation. */
export const WORD_BITS = 64n;

const BIT_POSITIONS: ReadonlyMap<string, bigint> = new Map(
  PERMISSIONS.map((permission, index) => [permission, BigInt(index)]),
);

export const isPermission = (value: string): value is Permission => BIT_POSITIONS.has(value);

export const permissionBit = (permission: Permission): bigint => {
  const position = BIT_POSITIONS.get(permission);
  if (position === undefined) {
    // A miss is impossible for the typed input; it means the registry was mutated at runtime.
    throw new RangeError(`Unknown permission: ${String(permission)}`);
  }
  return 1n << position;
};

const MAX_BITS = (1n << BigInt(PERMISSION_COUNT)) - 1n;
const DECIMAL_PATTERN = /^(0|[1-9]\d{0,38})$/;

/**
 * A set of permissions encoded as one unsigned integer of unbounded width.
 * Immutable: every operation returns a new mask.
 */
export class PermissionMask {
  public static readonly NONE = new PermissionMask(0n);

  private constructor(private readonly bits: bigint) {}

  public static fromList(permissions: Iterable<Permission>): PermissionMask {
    let bits = 0n;
    for (const permission of permissions) bits |= permissionBit(permission);
    return new PermissionMask(bits);
  }

  /** Rehydrates a mask previously serialised with `toString()`. Rejects garbage and overflow. */
  public static fromString(value: string): PermissionMask | null {
    // Canonical decimal only: no sign, no leading zeros, no separators.
    if (!DECIMAL_PATTERN.test(value)) return null;
    const bits = BigInt(value);
    if (bits < 0n || bits > MAX_BITS) return null;
    return new PermissionMask(bits);
  }

  /** Rehydrates from fixed-width 64-bit words, least-significant word first. */
  public static fromWords(words: readonly string[]): PermissionMask | null {
    let bits = 0n;
    for (let index = words.length - 1; index >= 0; index -= 1) {
      const word = words[index];
      if (word === undefined || !/^(0|[1-9]\d{0,19})$/.test(word)) return null;
      const value = BigInt(word);
      if (value > 0xffff_ffff_ffff_ffffn) return null;
      bits = (bits << WORD_BITS) | value;
    }
    return bits > MAX_BITS ? null : new PermissionMask(bits);
  }

  public has(permission: Permission): boolean {
    return (this.bits & permissionBit(permission)) !== 0n;
  }

  /** Every listed permission must be present. */
  public hasAll(permissions: Iterable<Permission>): boolean {
    for (const permission of permissions) if (!this.has(permission)) return false;
    return true;
  }

  /** At least one listed permission must be present. Empty input is false. */
  public hasAny(permissions: Iterable<Permission>): boolean {
    for (const permission of permissions) if (this.has(permission)) return true;
    return false;
  }

  public union(other: PermissionMask): PermissionMask {
    return new PermissionMask(this.bits | other.bits);
  }

  public intersect(other: PermissionMask): PermissionMask {
    return new PermissionMask(this.bits & other.bits);
  }

  /** Removes every permission in `other`. */
  public except(other: PermissionMask): PermissionMask {
    return new PermissionMask(this.bits & ~other.bits & MAX_BITS);
  }

  public toList(): Permission[] {
    return PERMISSIONS.filter((permission) => this.has(permission));
  }

  public isEmpty(): boolean {
    return this.bits === 0n;
  }

  public equals(other: PermissionMask): boolean {
    return this.bits === other.bits;
  }

  /** Number of distinct permissions held. O(n) in catalogue size, for diagnostics only. */
  public cardinality(): number {
    let count = 0;
    let remaining = this.bits;
    while (remaining > 0n) {
      if ((remaining & 1n) === 1n) count += 1;
      remaining >>= 1n;
    }
    return count;
  }

  /** Canonical decimal string form — safe as a Redis value and a Postgres numeric literal. */
  public toString(): string {
    return this.bits.toString();
  }

  /** Fixed-width 64-bit words, least-significant first, for binary column storage. */
  public toWords(): readonly string[] {
    const words: string[] = [];
    let remaining = this.bits;
    do {
      words.push((remaining & 0xffff_ffff_ffff_ffffn).toString());
      remaining >>= WORD_BITS;
    } while (remaining > 0n);
    return words;
  }
}

/**
 * Aggregates the permissions granted by several roles into one mask.
 * Role grants are unioned — a role can only add capability, never remove it —
 * and negative grants are expressed by withholding the role instead.
 */
export const aggregatePermissions = (grants: Iterable<Iterable<Permission>>): PermissionMask => {
  let mask = PermissionMask.NONE;
  for (const grant of grants) mask = mask.union(PermissionMask.fromList(grant));
  return mask;
};
