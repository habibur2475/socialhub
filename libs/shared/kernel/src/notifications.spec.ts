import { describe, expect, it } from 'vitest';

import {
  decideNotification,
  extractMentions,
  MENTION_LIMIT,
  NOTIFICATION_KINDS,
  unreadBadge,
} from './notifications.js';

const candidate = (overrides: Partial<Parameters<typeof decideNotification>[0]> = {}) => ({
  kind: 'LIKE' as const,
  actorId: 'actor',
  recipientId: 'recipient',
  blocked: false,
  entitled: true,
  ...overrides,
});

describe('decideNotification', () => {
  it('notifies an entitled recipient', () => {
    expect(decideNotification(candidate())).toEqual({ notify: true, kind: 'LIKE' });
  });

  /**
   * A blocked account must not be able to reach the notification list, or the
   * block is cosmetic. Checked before every other rule so no branch can bypass it.
   */
  it('refuses across a block, before any other rule', () => {
    expect(decideNotification(candidate({ blocked: true }))).toEqual({
      notify: false,
      reason: 'BLOCKED',
    });
    // Even a self-action would be reported as blocked, so the ordering is explicit.
    expect(
      decideNotification(candidate({ blocked: true, actorId: 'same', recipientId: 'same' })),
    ).toEqual({ notify: false, reason: 'BLOCKED' });
  });

  it('never notifies you about your own action', () => {
    expect(decideNotification(candidate({ actorId: 'me', recipientId: 'me' }))).toEqual({
      notify: false,
      reason: 'SELF_ACTION',
    });
  });

  it('refuses when the recipient is not entitled to know', () => {
    // A like on a post the recipient cannot see must not be announced.
    expect(decideNotification(candidate({ entitled: false }))).toEqual({
      notify: false,
      reason: 'NOT_ENTITLED',
    });
  });

  it('rejects an unknown kind by closing the set', () => {
    const bogus = candidate({ kind: 'POKE' as never });
    expect(decideNotification(bogus)).toEqual({ notify: false, reason: 'UNKNOWN_KIND' });
  });

  it('covers every declared kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(decideNotification(candidate({ kind }))).toEqual({ notify: true, kind });
    }
  });
});

describe('extractMentions', () => {
  it('finds a plain mention', () => {
    expect(extractMentions('hello @ada_lovelace how are you')).toEqual(['ada_lovelace']);
  });

  it('finds a mention at the start and de-duplicates', () => {
    expect(extractMentions('@ada hi @ada')).toEqual(['ada']);
  });

  /**
   * An email address inside a post is common, and treating its domain as a mention
   * would notify a stranger every time someone shares a contact address.
   */
  it('does not treat an email address as a mention', () => {
    expect(extractMentions('write to me at ada@example.test')).toEqual([]);
  });

  it('ignores a mention-shaped run without the @', () => {
    expect(extractMentions('ada_lovelace is my handle')).toEqual([]);
  });

  it('ignores a too-short or invalid handle', () => {
    expect(extractMentions('@ab')).toEqual([]);
    expect(extractMentions('@Ada')).toEqual([]);
  });

  it('caps the number of mentions', () => {
    const body = Array.from({ length: MENTION_LIMIT + 5 }, (_, index) => `@user_${index}`).join(
      ' ',
    );
    expect(extractMentions(body)).toHaveLength(MENTION_LIMIT);
  });

  it('handles punctuation after a mention', () => {
    expect(extractMentions('thanks @grace_hopper!')).toEqual(['grace_hopper']);
    expect(extractMentions('cc @linus_t, @ada')).toEqual(['linus_t', 'ada']);
  });
});

describe('unreadBadge', () => {
  it('caps the displayed count', () => {
    expect(unreadBadge(5)).toBe('5');
    expect(unreadBadge(99)).toBe('99');
    // The only information a badge needs to convey is "act on this".
    expect(unreadBadge(1_284)).toBe('99+');
  });

  it('never renders a negative count', () => {
    expect(unreadBadge(-3)).toBe('0');
  });
});
