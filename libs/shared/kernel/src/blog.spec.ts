import { describe, expect, it } from 'vitest';

import {
  ARTICLE_BODY_MAX_LENGTH,
  ARTICLE_EXCERPT_MAX_LENGTH,
  ARTICLE_TITLE_MAX_LENGTH,
  canReadArticle,
  decideTransition,
  effectiveStatus,
  excerptOf,
  hasUnbalancedFence,
  isDue,
  normaliseTags,
  prepareArticle,
  readingMinutes,
  slugFor,
  slugify,
  fallbackSlug,
} from './blog.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const LATER = new Date('2026-03-02T12:00:00.000Z');
const EARLIER = new Date('2026-02-28T12:00:00.000Z');

describe('decideTransition', () => {
  const base = { complete: true, scheduledFor: null, now: NOW } as const;

  it('publishes a draft immediately and records the moment', () => {
    const decision = decideTransition({ ...base, from: 'DRAFT', to: 'PUBLISHED' });
    expect(decision).toEqual({ allowed: true, publishedAt: NOW });
  });

  // A draft that was live last week is still a draft; a boolean cannot say that.
  it('allows the retreat from published back to draft', () => {
    expect(decideTransition({ ...base, from: 'PUBLISHED', to: 'DRAFT' })).toEqual({
      allowed: true,
      publishedAt: null,
    });
  });

  it('refuses to resurrect an archived article', () => {
    for (const to of ['DRAFT', 'SCHEDULED', 'PUBLISHED'] as const) {
      expect(decideTransition({ ...base, from: 'ARCHIVED', to })).toEqual({
        allowed: false,
        reason: 'INVALID_TRANSITION',
      });
    }
  });

  it('refuses to skip a schedule', () => {
    expect(decideTransition({ ...base, from: 'DRAFT', to: 'SCHEDULED' }).allowed).toBe(false);
  });

  it('requires something to read before publishing or scheduling', () => {
    const incomplete = { ...base, complete: false };
    expect(decideTransition({ ...incomplete, from: 'DRAFT', to: 'PUBLISHED' })).toEqual({
      allowed: false,
      reason: 'NOTHING_TO_PUBLISH',
    });
    expect(
      decideTransition({ ...incomplete, from: 'DRAFT', to: 'SCHEDULED', scheduledFor: LATER }),
    ).toEqual({ allowed: false, reason: 'NOTHING_TO_PUBLISH' });
  });

  it('requires a date to schedule, and refuses one in the past', () => {
    expect(decideTransition({ ...base, from: 'DRAFT', to: 'SCHEDULED' })).toEqual({
      allowed: false,
      reason: 'SCHEDULE_WITHOUT_DATE',
    });
    expect(
      decideTransition({ ...base, from: 'DRAFT', to: 'SCHEDULED', scheduledFor: EARLIER }),
    ).toEqual({ allowed: false, reason: 'SCHEDULE_IN_THE_PAST' });
    // Exactly now is the past: the moment has arrived, so publish rather than schedule.
    expect(
      decideTransition({ ...base, from: 'DRAFT', to: 'SCHEDULED', scheduledFor: NOW }),
    ).toEqual({ allowed: false, reason: 'SCHEDULE_IN_THE_PAST' });
  });

  // Correcting a typo'd time is not a state change, and forcing publish-then-unpublish to
  // reach it would be a worse state machine than the one this test protects.
  it('reschedules a scheduled article', () => {
    expect(
      decideTransition({ ...base, from: 'SCHEDULED', to: 'SCHEDULED', scheduledFor: LATER }),
    ).toEqual({ allowed: true, publishedAt: null });
  });

  it('refuses a reschedule into the past', () => {
    expect(
      decideTransition({ ...base, from: 'SCHEDULED', to: 'SCHEDULED', scheduledFor: EARLIER }),
    ).toEqual({ allowed: false, reason: 'SCHEDULE_IN_THE_PAST' });
  });

  it('accepts a future schedule without publishing it', () => {
    expect(
      decideTransition({ ...base, from: 'DRAFT', to: 'SCHEDULED', scheduledFor: LATER }),
    ).toEqual({ allowed: true, publishedAt: null });
  });

  // Moving the date of a corrected article would reorder every archive it appears in.
  it('keeps the original publication moment when republishing', () => {
    expect(
      decideTransition({ ...base, from: 'DRAFT', to: 'PUBLISHED', scheduledFor: EARLIER }),
    ).toEqual({ allowed: true, publishedAt: EARLIER });
  });
});

describe('isDue and effectiveStatus', () => {
  const scheduled = { status: 'SCHEDULED', publishedAt: null, scheduledFor: LATER } as const;

  it('is not due before its moment, and is due after', () => {
    expect(isDue({ ...scheduled, now: NOW })).toBe(false);
    expect(isDue({ ...scheduled, now: LATER })).toBe(true);
  });

  it('reports a due schedule as published to a reader', () => {
    expect(effectiveStatus({ ...scheduled, now: LATER })).toBe('PUBLISHED');
    expect(effectiveStatus({ ...scheduled, now: NOW })).toBe('SCHEDULED');
  });

  it('never publishes a draft, however old', () => {
    expect(isDue({ status: 'DRAFT', publishedAt: EARLIER, scheduledFor: EARLIER, now: NOW })).toBe(
      false,
    );
  });
});

describe('canReadArticle', () => {
  const article = {
    status: 'DRAFT',
    publishedAt: null,
    scheduledFor: null,
    authorId: 'ada',
    viewerId: 'grace',
    now: NOW,
  } as const;

  it('lets the author read their own draft', () => {
    expect(canReadArticle({ ...article, viewerId: 'ada' })).toBe(true);
  });

  it('hides a draft from everyone else, and an archived article too', () => {
    expect(canReadArticle(article)).toBe(false);
    expect(canReadArticle({ ...article, status: 'ARCHIVED', viewerId: 'grace' })).toBe(false);
  });

  it('shows a scheduled article once it is due', () => {
    const scheduled = {
      ...article,
      status: 'SCHEDULED',
      scheduledFor: LATER,
    } as const;
    expect(canReadArticle(scheduled)).toBe(false);
    expect(canReadArticle({ ...scheduled, now: LATER })).toBe(true);
  });
});

describe('slugify', () => {
  it('makes a URL out of a title', () => {
    expect(slugify('Shipping a monorepo in 90 days')).toBe('shipping-a-monorepo-in-90-days');
  });

  it('strips diacritics instead of dropping the letter', () => {
    expect(slugify('Café Society')).toBe('cafe-society');
  });

  it('collapses punctuation instead of leaving empty segments', () => {
    expect(slugify('TypeScript:   why — and when?')).toBe('typescript-why-and-when');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  ...hello...  ')).toBe('hello');
  });

  // A Bengali title has no Latin letters to slug; the fallback is what keeps it linkable.
  it('produces nothing for a title with no Latin characters', () => {
    expect(slugify('বাংলায় লেখা')).toBe('');
    expect(slugFor('বাংলায় লেখা', '0190f3c1-abcd')).toBe('article-0190f3c1abcd');
  });

  it('falls back when the slug would be too short', () => {
    expect(slugFor('a', 'abc123')).toBe(fallbackSlug('abc123'));
    expect(slugFor('Real Title', 'abc123')).toBe('real-title');
  });
});

describe('excerptOf', () => {
  it('collapses a multi-paragraph body into one line', () => {
    expect(excerptOf('First line.\n\nSecond   line.')).toBe('First line. Second line.');
  });

  it('drops heading and list markers so the excerpt does not begin with ##', () => {
    expect(excerptOf('## A heading\n\n- one\n- two')).toBe('A heading one two');
  });

  it('does not cut a long excerpt mid-word when a boundary is close', () => {
    const excerpt = excerptOf('word '.repeat(100));
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.endsWith('word…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(ARTICLE_EXCERPT_MAX_LENGTH);
  });

  it('leaves a short body exactly as written', () => {
    expect(excerptOf('Short and complete.')).toBe('Short and complete.');
  });

  it('respects a custom limit', () => {
    expect(excerptOf('alpha beta gamma delta', 15)).toBe('alpha beta…');
  });
});

describe('readingMinutes', () => {
  it('never reports zero minutes', () => {
    expect(readingMinutes('a single short sentence')).toBe(1);
    expect(readingMinutes('')).toBe(1);
  });

  it('rounds up, so the estimate is never a broken promise', () => {
    // 201 words is two minutes even though it is barely past one.
    expect(readingMinutes('word '.repeat(201))).toBe(2);
    expect(readingMinutes('word '.repeat(200))).toBe(1);
  });
});

describe('normaliseTags', () => {
  it('lowercases, trims and deduplicates', () => {
    expect(normaliseTags(['PostgreSQL', ' postgresql ', 'TypeScript'])).toEqual([
      'postgresql',
      'typescript',
    ]);
  });

  it('turns an internal space into a hyphen so a tag stays one word', () => {
    expect(normaliseTags(['Unit Testing'])).toEqual(['unit-testing']);
  });

  it('caps the list', () => {
    expect(normaliseTags(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('drops empty entries', () => {
    expect(normaliseTags(['', '   ', 'ok'])).toEqual(['ok']);
  });
});

describe('hasUnbalancedFence', () => {
  it('accepts a closed code block', () => {
    expect(hasUnbalancedFence('before\n```ts\nconst a = 1;\n```\nafter')).toBe(false);
  });

  it('rejects an unclosed one', () => {
    expect(hasUnbalancedFence('before\n```ts\nconst a = 1;')).toBe(true);
  });

  it('ignores a fence that is indented inside a code block', () => {
    expect(hasUnbalancedFence('text\n    ```\nmore')).toBe(false);
  });
});

describe('prepareArticle', () => {
  it('trims the title and keeps the body line breaks', () => {
    const decision = prepareArticle({ title: '  A  title  ', body: '  line one\nline two  ' });
    expect(decision).toEqual({ allowed: true, title: 'A title', body: 'line one\nline two' });
  });

  it('rejects an empty title and an empty body with distinct reasons', () => {
    expect(prepareArticle({ title: '   ', body: 'text' })).toEqual({
      allowed: false,
      reason: 'EMPTY_TITLE',
    });
    expect(prepareArticle({ title: 'Title', body: '   ' })).toEqual({
      allowed: false,
      reason: 'EMPTY_BODY',
    });
  });

  it('enforces the limits', () => {
    expect(
      prepareArticle({ title: 'x'.repeat(ARTICLE_TITLE_MAX_LENGTH + 1), body: 'text' }),
    ).toEqual({ allowed: false, reason: 'TITLE_TOO_LONG' });
    expect(
      prepareArticle({ title: 'Title', body: 'x'.repeat(ARTICLE_BODY_MAX_LENGTH + 1) }),
    ).toEqual({ allowed: false, reason: 'BODY_TOO_LONG' });
  });
});
