/**
 * Messaging client logic.
 *
 * The parts worth pinning down are the ones with no server in the loop: the idempotency
 * key must always be a uuid (the server keys on it), and the frame guards must recognise
 * only the frames they claim — a guard that accepts everything would append a
 * notification frame to a transcript.
 */

import { describe, expect, it } from 'vitest';

import type { MessageView, ThreadSummary } from '@socialhub/contracts';

import {
  isMessageDeletedFrame,
  isMessageFrame,
  isThreadFrame,
  newClientId,
} from '@/lib/messaging-api';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const message: MessageView = {
  id: '0190f3c1-0000-7000-8000-0000000000e1',
  threadId: '0190f3c1-0000-7000-8000-0000000000d1',
  sender: { accountId: 'a', username: 'ada', displayName: 'Ada', avatarKey: null },
  body: 'hello',
  deleted: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  clientId: null,
};

const thread: ThreadSummary = {
  id: '0190f3c1-0000-7000-8000-0000000000d1',
  kind: 'GROUP',
  title: 'Team',
  participants: [],
  lastMessageAt: '2026-01-01T00:00:00.000Z',
  lastMessagePreview: null,
  unreadCount: 1,
  locked: false,
  viewerIsOwner: true,
};

describe('newClientId', () => {
  it('produces a v4 uuid the server will accept as an idempotency key', () => {
    expect(newClientId()).toMatch(UUID_PATTERN);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newClientId()));
    expect(ids.size).toBe(50);
  });
});

describe('frame guards', () => {
  it('recognises a message frame', () => {
    expect(isMessageFrame({ type: 'message', threadId: 't', message, unreadCount: 2 })).toBe(true);
  });

  it('recognises a thread frame', () => {
    expect(isThreadFrame({ type: 'thread', thread })).toBe(true);
  });

  it('recognises a delete frame', () => {
    expect(
      isMessageDeletedFrame({ type: 'message-deleted', threadId: 't', messageId: 'm', message }),
    ).toBe(true);
  });

  /** The other types on the shared stream must not be mistaken for a message. */
  it('rejects the notification frames that share the connection', () => {
    expect(isMessageFrame({ type: 'unread', unreadCount: 3 })).toBe(false);
    expect(isMessageFrame({ type: 'ping' })).toBe(false);
    expect(isThreadFrame({ type: 'notification', notification: {} })).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isMessageFrame(null)).toBe(false);
    expect(isMessageFrame('message')).toBe(false);
  });
});
