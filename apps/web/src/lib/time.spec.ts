import { describe, expect, it } from 'vitest';

import { absoluteTime, relativeTime } from './time';

const NOW = new Date('2026-01-15T12:00:00.000Z');

/** Builds an ISO timestamp that is `minutes` before NOW. */
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();

describe('relativeTime', () => {
  it('describes seconds, minutes and hours', () => {
    expect(relativeTime(ago(0.5), NOW)).toBe('now');
    expect(relativeTime(ago(5), NOW)).toBe('5 minutes ago');
    expect(relativeTime(ago(3 * 60), NOW)).toBe('3 hours ago');
  });

  it('switches to days, weeks and months at sensible boundaries', () => {
    expect(relativeTime(ago(24 * 60), NOW)).toBe('yesterday');
    expect(relativeTime(ago(3 * 24 * 60), NOW)).toBe('3 days ago');
    expect(relativeTime(ago(14 * 24 * 60), NOW)).toBe('2 weeks ago');
    expect(relativeTime(ago(60 * 24 * 60), NOW)).toBe('2 months ago');
  });

  it('never counts down', () => {
    // A future timestamp is clock skew, not a prediction. Showing "in 2 seconds"
    // would be rendered once and then be wrong forever.
    const future = new Date(NOW.getTime() + 120_000).toISOString();
    expect(relativeTime(future, NOW)).not.toContain('in ');
  });

  it('returns an empty string for an unparseable timestamp', () => {
    expect(relativeTime('not a date', NOW)).toBe('');
  });
});

describe('absoluteTime', () => {
  it('renders a readable local timestamp', () => {
    const formatted = absoluteTime('2026-01-15T12:00:00.000Z');
    expect(formatted).toMatch(/2026/);
    expect(formatted).not.toBe('');
  });

  it('returns an empty string for an unparseable timestamp', () => {
    expect(absoluteTime('nope')).toBe('');
  });
});
