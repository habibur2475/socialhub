/**
 * Identifier generation — UUIDv7, time-ordered.
 *
 * v7 embeds a 48-bit millisecond timestamp ahead of the random tail, so ids sort
 * chronologically. That is what makes B-tree inserts on a sharded Postgres
 * append-mostly instead of scattering across the index, and it gives every row a
 * free creation time without a second column.
 *
 * Layout: 48-bit unix_ts_ms | 4-bit version | 12-bit rand_a | 2-bit variant | 62-bit rand_b
 */

import { randomBytes } from 'node:crypto';

const HEX = '0123456789abcdef';

/** Milliseconds fit in 48 bits until the year 10889. */
const MAX_V7_TIMESTAMP = 0xff_ff_ff_ff_ff_ff;

const toHex = (value: bigint, width: number): string => {
  let out = '';
  for (let index = width - 1; index >= 0; index -= 1) {
    const nibble = Number((value >> BigInt(index * 4)) & 0xfn);
    out += HEX[nibble];
  }
  return out;
};

const group = (hex: string, index: number, length: number): string => {
  const value = hex.slice(index, index + length);
  if (value.length !== length) throw new RangeError('Malformed identifier buffer');
  return value;
};

export const uuidv7 = (now: number = Date.now()): string => {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_V7_TIMESTAMP) {
    throw new RangeError('Timestamp must be an integer within the 48-bit millisecond epoch range');
  }

  const random = randomBytes(10);

  // Compose the 128-bit value field by field so the bit budget is auditable:
  //   48 timestamp | 4 version (7) | 12 rand_a | 2 variant (0b10) | 62 rand_b
  const randA = ((BigInt(random[0] ?? 0) & 0x0fn) << 8n) | BigInt(random[1] ?? 0);
  let randB = 0n;
  for (let index = 2; index < 10; index += 1) {
    randB = (randB << 8n) | BigInt(random[index] ?? 0);
  }

  const value =
    (BigInt(now) << 80n) | (0x7n << 76n) | (randA << 64n) | (0b10n << 62n) | (randB & 0x3fff_ffff_ffff_ffffn);

  return formatUuid(value);
};

/** Renders a 128-bit value as canonical 8-4-4-4-12 lowercase hex. */
const formatUuid = (value: bigint): string => {
  const hex = toHex(value, 32);
  return [group(hex, 0, 8), group(hex, 8, 4), group(hex, 12, 4), group(hex, 16, 4), group(hex, 20, 12)].join('-');
};

/** Extracts the embedded creation timestamp, or null when the value is not a v7 id. */
export const uuidv7Time = (id: string): number | null => {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(id);
  if (match === null) return null;
  const high = Number.parseInt(match[1] ?? '', 16);
  const low = Number.parseInt(match[2] ?? '', 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return high * 0x10000 + low;
};

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Human-shareable short code (8 chars, Crockford base32, collision-checked at the DB layer). */
export const shortCode = (length = 8): string => {
  if (length < 4 || length > 32) throw new RangeError('Short code length must be between 4 and 32');
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += CROCKFORD[byte % CROCKFORD.length] ?? '0';
  return out;
};
