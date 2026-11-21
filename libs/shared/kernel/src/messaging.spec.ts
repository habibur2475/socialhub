import { describe, expect, it } from 'vitest';

import {
  GROUP_MEMBER_LIMIT,
  MESSAGE_BODY_MAX_LENGTH,
  compareThreads,
  decideDirectThread,
  decideSend,
  extractMessageMentions,
  isUnread,
  messagePreview,
  prepareMessageBody,
  threadTitle,
} from './messaging.js';

const context = (overrides: Partial<Parameters<typeof decideDirectThread>[0]> = {}) => ({
  blocked: false,
  senderFollowsRecipient: false,
  recipientFollowsSender: false,
  threadExists: false,
  ...overrides,
});

describe('prepareMessageBody', () => {
  it('trims the ends and keeps interior whitespace', () => {
    const decision = prepareMessageBody('  line one\n    indented\n  ');
    expect(decision).toEqual({ allowed: true, body: 'line one\n    indented' });
  });

  it('refuses an empty or whitespace-only body', () => {
    expect(prepareMessageBody('   ')).toEqual({ allowed: false, reason: 'EMPTY' });
    expect(prepareMessageBody('')).toEqual({ allowed: false, reason: 'EMPTY' });
  });

  /** Counted in code points: an emoji is one character to the author. */
  it('counts code points rather than UTF-16 units', () => {
    const emoji = '🙂'.repeat(MESSAGE_BODY_MAX_LENGTH);
    expect(prepareMessageBody(emoji).allowed).toBe(true);
    expect(prepareMessageBody(`${emoji}🙂`)).toEqual({ allowed: false, reason: 'TOO_LONG' });
  });
});

describe('decideDirectThread', () => {
  /** A block outranks everything, including a mutual follow. */
  it('refuses when either party has blocked the other', () => {
    expect(
      decideDirectThread(
        context({ blocked: true, senderFollowsRecipient: true, recipientFollowsSender: true }),
      ),
    ).toEqual({ allowed: false, reason: 'BLOCKED' });
    expect(decideDirectThread(context({ blocked: true, threadExists: true }))).toEqual({
      allowed: false,
      reason: 'BLOCKED',
    });
  });

  it('allows a mutual follow', () => {
    expect(
      decideDirectThread(context({ senderFollowsRecipient: true, recipientFollowsSender: true })),
    ).toEqual({ allowed: true, reason: 'MUTUAL' });
  });

  /** A one-way follow may open the thread; the reply is what makes it mutual. */
  it('allows a one-way follow to initiate', () => {
    expect(decideDirectThread(context({ senderFollowsRecipient: true }))).toEqual({
      allowed: true,
      reason: 'ONE_WAY',
    });
  });

  it('refuses when only the recipient follows the sender', () => {
    // The right to continue a conversation belongs to the person who was followed.
    expect(decideDirectThread(context({ recipientFollowsSender: true }))).toEqual({
      allowed: false,
      reason: 'NO_RELATIONSHIP',
    });
  });

  it('lets an existing thread continue without a follow either way', () => {
    expect(decideDirectThread(context({ threadExists: true }))).toEqual({
      allowed: true,
      reason: 'EXISTING',
    });
  });
});

describe('decideSend', () => {
  it('allows a member of a live thread', () => {
    expect(decideSend({ isMember: true, locked: false, blocked: false })).toEqual({
      allowed: true,
    });
  });

  it('refuses a block before membership, so a group is not a way around it', () => {
    expect(decideSend({ isMember: true, locked: false, blocked: true })).toEqual({
      allowed: false,
      reason: 'BLOCKED',
    });
  });

  it('refuses a non-member and a locked thread distinctly', () => {
    expect(decideSend({ isMember: false, locked: false, blocked: false })).toEqual({
      allowed: false,
      reason: 'NOT_A_MEMBER',
    });
    expect(decideSend({ isMember: true, locked: true, blocked: false })).toEqual({
      allowed: false,
      reason: 'THREAD_LOCKED',
    });
  });
});

describe('messagePreview', () => {
  it('collapses newlines so the row stays one line', () => {
    expect(messagePreview('first\n\nsecond\tthird')).toBe('first second third');
  });

  it('truncates at the preview length with an ellipsis', () => {
    const preview = messagePreview('x'.repeat(200));
    expect([...preview].length).toBe(120);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('leaves a short body alone', () => {
    expect(messagePreview('  short  ')).toBe('short');
  });
});

describe('extractMessageMentions', () => {
  it('finds mentions and ignores email addresses', () => {
    expect(extractMessageMentions('hi @ada, write to grace@example.test')).toEqual(['ada']);
  });

  it('de-duplicates and keeps order', () => {
    expect(extractMessageMentions('@ada @grace @ada')).toEqual(['ada', 'grace']);
  });
});

describe('isUnread', () => {
  /** A message you sent from another tab is not unread mail. */
  it('ignores the reader own messages', () => {
    expect(isUnread(0)).toBe(false);
    expect(isUnread(1)).toBe(true);
  });
});

describe('threadTitle', () => {
  it('names a direct thread after the other participant', () => {
    expect(
      threadTitle({ kind: 'DIRECT', groupTitle: null, otherDisplayName: 'Ada', memberNames: [] }),
    ).toBe('Ada');
  });

  it('falls back when the other account is gone', () => {
    expect(
      threadTitle({ kind: 'DIRECT', groupTitle: null, otherDisplayName: null, memberNames: [] }),
    ).toBe('Conversation');
  });

  it('uses a group title when present', () => {
    expect(
      threadTitle({
        kind: 'GROUP',
        groupTitle: 'Release planning',
        otherDisplayName: null,
        memberNames: ['Ada'],
      }),
    ).toBe('Release planning');
  });

  it('falls back to members rather than rendering an empty header', () => {
    expect(
      threadTitle({
        kind: 'GROUP',
        groupTitle: '   ',
        otherDisplayName: null,
        memberNames: ['Ada', 'Grace', 'Linus', 'Eve'],
      }),
    ).toBe('Ada, Grace, Linus');
  });

  it('handles a group with no members recorded', () => {
    expect(
      threadTitle({ kind: 'GROUP', groupTitle: null, otherDisplayName: null, memberNames: [] }),
    ).toBe('Group conversation');
  });
});

describe('compareThreads', () => {
  const at = (minute: number): Date =>
    new Date(`2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`);

  it('puts an unread thread ahead of a read one, however old', () => {
    const unread = { lastMessageAt: at(1), unread: true };
    const read = { lastMessageAt: at(59), unread: false };
    // Recency alone would put the fresh read thread first; the unread flag wins.
    expect([read, unread].sort(compareThreads)[0]).toBe(unread);
  });

  it('orders by recency within the same read state', () => {
    const older = { lastMessageAt: at(1), unread: false };
    const newer = { lastMessageAt: at(30), unread: false };
    expect([older, newer].sort(compareThreads)[0]).toBe(newer);
  });
});

describe('limits', () => {
  it('keeps the group ceiling explicit', () => {
    expect(GROUP_MEMBER_LIMIT).toBe(50);
  });
});
