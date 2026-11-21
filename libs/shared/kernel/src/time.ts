/**
 * Time primitives shared by every service.
 *
 * Instants are epoch milliseconds; anything user-facing gets a timezone at the
 * rendering boundary. Durations are typed so that a raw number can never be
 * mistaken for milliseconds in a retry or token-lifetime calculation.
 */

export type Millis = number & { readonly __unit: 'ms' };

export const ms = (value: number): Millis => {
  if (!Number.isFinite(value)) throw new RangeError('Duration must be finite');
  return Math.trunc(value) as Millis;
};

export const SECONDS = 1_000;
export const MINUTES = 60 * SECONDS;
export const HOURS = 60 * MINUTES;
export const DAYS = 24 * HOURS;

export const withoutUndefined = <T extends Record<string, unknown>>(value: T): Partial<T> => {
  const result: Partial<T> = {};
  for (const key of Object.keys(value) as (keyof T)[]) {
    const entry = value[key];
    if (entry !== undefined) result[key] = entry;
  }
  return result;
};

/** Fixed-length retry backoff with full jitter, bounded by `max`. */
export const jitteredBackoff = (
  attempt: number,
  base: Millis = ms(200),
  max: Millis = ms(30_000),
  random: () => number = Math.random,
): Millis => {
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt));
  return ms(Math.floor(random() * ceiling));
};
