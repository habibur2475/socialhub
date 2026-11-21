import { describe, expect, it } from 'vitest';

import {
  clampPageSize,
  effectiveReplyVisibility,
  isWithinTimelineWindow,
  POST_BODY_MAX_LENGTH,
  prepareBody,
  requiresAudienceRows,
  TIMELINE_PAGE_MAX,
  timelineScore,
} from './feed.js';

describe('post body', () => {
  it('rejects a body that is only whitespace', () => {
    expect(prepareBody('   \n\t ')).toEqual({ allowed: false, reason: 'EMPTY' });
  });

  it('trims the edges but preserves internal whitespace', () => {
    // A poem's line breaks and a code block's indentation are content.
    const result = prepareBody('  line one\n  line two  ');
    expect(result).toEqual({ allowed: true, body: 'line one\n  line two' });
  });

  it('measures length in code points, not UTF-16 units', () => {
    // 5000 emoji = 5000 code points (exactly the limit) but 10,000 UTF-16 units,
    // so a naive `length` check would reject a body the author sees as 5000.
    const atLimit = '🚀'.repeat(POST_BODY_MAX_LENGTH);
    expect(prepareBody(atLimit)).toEqual({ allowed: true, body: atLimit });

    const overLimit = `${atLimit}x`;
    expect(prepareBody(overLimit)).toEqual({ allowed: false, reason: 'TOO_LONG' });
  });

  it('accepts a single character', () => {
    expect(prepareBody('a')).toEqual({ allowed: true, body: 'a' });
  });
});

describe('audience', () => {
  it('materialises rows only for FOLLOWERS', () => {
    // PUBLIC is unbounded and PRIVATE has one member, resolved by author id.
    expect(requiresAudienceRows('FOLLOWERS')).toBe(true);
    expect(requiresAudienceRows('PUBLIC')).toBe(false);
    expect(requiresAudienceRows('PRIVATE')).toBe(false);
  });

  it('never widens a reply beyond its parent', () => {
    // A public reply to a followers-only post would leak the parent's content.
    expect(effectiveReplyVisibility('PUBLIC', 'FOLLOWERS')).toBe('FOLLOWERS');
    expect(effectiveReplyVisibility('PUBLIC', 'PRIVATE')).toBe('PRIVATE');
  });

  it('keeps a reply at or below its parent level', () => {
    expect(effectiveReplyVisibility('PRIVATE', 'PUBLIC')).toBe('PRIVATE');
    expect(effectiveReplyVisibility('FOLLOWERS', 'PUBLIC')).toBe('FOLLOWERS');
    expect(effectiveReplyVisibility('PUBLIC', 'PUBLIC')).toBe('PUBLIC');
  });
});

describe('timeline scoring', () => {
  const base = { ageHours: 0, likeCount: 0, replyCount: 0, repostCount: 0 };

  it('ranks a fresh post above an older one with the same engagement', () => {
    expect(timelineScore(base)).toBeGreaterThan(timelineScore({ ...base, ageHours: 12 }));
  });

  it('halves the decay factor every half-life', () => {
    const fresh = timelineScore(base);
    const oneHalfLife = timelineScore({ ...base, ageHours: 6 });
    expect(oneHalfLife).toBeCloseTo(fresh * 0.5, 10);
  });

  it('ranks a reply above a like, and a repost above a reply', () => {
    const like = timelineScore({ ...base, likeCount: 1 });
    const reply = timelineScore({ ...base, replyCount: 1 });
    const repost = timelineScore({ ...base, repostCount: 1 });

    expect(reply).toBeGreaterThan(like);
    expect(repost).toBeGreaterThan(reply);
  });

  /**
   * Engagement must not defeat decay: a post from a day ago with ten thousand
   * likes should not outrank a fresh one forever, or the feed becomes a museum.
   */
  it('lets decay overcome very large engagement', () => {
    const fresh = timelineScore(base);
    const ancientViral = timelineScore({ ...base, ageHours: 24 * 7, likeCount: 100_000 });
    expect(ancientViral).toBeLessThan(fresh);
  });

  it('never produces a negative score for a negative age', () => {
    // Clock skew between the application and the database is real; a future
    // timestamp must not rank above everything else.
    expect(timelineScore({ ...base, ageHours: -5 })).toBe(timelineScore(base));
  });
});

describe('timeline window and paging', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');

  it('includes a post inside the window and excludes one outside it', () => {
    expect(isWithinTimelineWindow(new Date('2026-01-14T12:00:00.000Z'), now)).toBe(true);
    expect(isWithinTimelineWindow(new Date('2026-01-01T12:00:00.000Z'), now)).toBe(false);
  });

  it('clamps an oversized page request instead of failing it', () => {
    // Failing punishes a plausible mistake; honouring it exhausts the pool.
    expect(clampPageSize(1_000)).toBe(TIMELINE_PAGE_MAX);
  });

  it('clamps a zero or negative page to one', () => {
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-5)).toBe(1);
  });

  it('falls back when the page size is absent or not finite', () => {
    expect(clampPageSize(undefined)).toBe(20);
    expect(clampPageSize(Number.NaN)).toBe(20);
  });
});
