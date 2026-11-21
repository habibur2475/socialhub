/**
 * Relative timestamps.
 *
 * `Intl.RelativeTimeFormat` is used rather than a hand-written "3m ago" table
 * because it localises correctly and pluralises without a lookup map. The
 * thresholds below are the only decision this module makes: how coarse to be
 * before switching unit.
 *
 * A post's age is cache-corrupting in the worst way — a client that caches "in 2
 * seconds" shows it forever — so every rendered value is a floor ("3 minutes
 * ago"), never a countdown, and the exact timestamp is always available in the
 * `datetime` attribute for assistive technology and for anyone who needs
 * precision.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** Chooses the coarsest unit that still describes the gap usefully. */
const unitFor = (seconds: number): { value: number; unit: Intl.RelativeTimeFormatUnit } => {
  const magnitude = Math.abs(seconds);

  if (magnitude < MINUTE) return { value: Math.round(seconds), unit: 'second' };
  if (magnitude < HOUR) return { value: Math.round(seconds / MINUTE), unit: 'minute' };
  if (magnitude < DAY) return { value: Math.round(seconds / HOUR), unit: 'hour' };
  if (magnitude < WEEK) return { value: Math.round(seconds / DAY), unit: 'day' };
  if (magnitude < MONTH) return { value: Math.round(seconds / WEEK), unit: 'week' };
  if (magnitude < YEAR) return { value: Math.round(seconds / MONTH), unit: 'month' };
  return { value: Math.round(seconds / YEAR), unit: 'year' };
};

/**
 * Human-readable age of a timestamp.
 *
 * `now` is a parameter so the result is testable without freezing the clock, and
 * so a list can render every item against one `now` instead of drifting down the
 * page as each row calls `Date.now()` separately.
 */
export const relativeTime = (iso: string, now: Date = new Date()): string => {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  // Negative because RelativeTimeFormat expresses the past as a negative delta.
  const seconds = (then.getTime() - now.getTime()) / 1_000;

  // Under a minute is "now" in either direction. "30 seconds ago" invites the
  // reader to watch the number, and a clock-skewed "in 20 seconds" is simply
  // wrong by the time it renders.
  if (Math.abs(seconds) < MINUTE) return formatter.format(0, 'second');

  // A future timestamp is clock skew between this browser and the server, not a
  // prediction. Publishing a countdown would make a cached page lie forever, so
  // anything ahead of now is reported as the present.
  const elapsed = Math.min(seconds, 0);
  const { value, unit } = unitFor(elapsed);

  return formatter.format(value, unit);
};

/** The absolute timestamp, for the `title` attribute and for `datetime`. */
export const absoluteTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};
