/**
 * Messaging service rules.
 *
 * What the service decides rather than what the database enforces: which refusals are
 * "not found" and which are "forbidden", that a deleted message is served as a
 * placeholder, and that a fan-out carries each recipient's own unread count. The
 * database properties (uniqueness, blocks, the read cursor) live in the e2e suite.
 */

import { describe, expect, it, vi } from 'vitest';

import { MessagingService, DELETED_MESSAGE_PLACEHOLDER } from './messaging.service.js';
import type {
  ConversationRecord,
  ConversationStore,
  DirectPairFacts,
  MessageRecord,
  SendFacts,
} from './ports.js';

const VIEWER = '0190f3c1-0000-7000-8000-00000000000a';
const OTHER = '0190f3c1-0000-7000-8000-00000000000b';
const THREAD = '0190f3c1-0000-7000-8000-0000000000d1';
const MESSAGE = '0190f3c1-0000-7000-8000-0000000000e1';

const participant = (accountId: string, displayName: string, owner = false) => ({
  accountId,
  username: displayName.toLowerCase(),
  displayName,
  avatarKey: null,
  owner,
  leftAt: null,
});

const conversation = (overrides: Partial<ConversationRecord> = {}): ConversationRecord => ({
  id: THREAD,
  kind: 'DIRECT',
  title: null,
  ownerId: VIEWER,
  locked: false,
  participants: [participant(VIEWER, 'Ada', true), participant(OTHER, 'Grace')],
  lastMessageAt: new Date('2026-01-01T00:00:00.000Z'),
  lastMessagePreview: null,
  unreadCount: 0,
  ...overrides,
});

const message = (overrides: Partial<MessageRecord> = {}): MessageRecord => ({
  id: MESSAGE,
  threadId: THREAD,
  senderId: VIEWER,
  sender: { accountId: VIEWER, username: 'ada', displayName: 'Ada', avatarKey: null },
  body: 'hello',
  deleted: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  clientId: null,
  ...overrides,
});

const pairFacts = (overrides: Partial<DirectPairFacts> = {}): DirectPairFacts => ({
  blocked: false,
  senderFollowsRecipient: true,
  recipientFollowsSender: true,
  threadId: null,
  ...overrides,
});

const sendFacts = (overrides: Partial<SendFacts> = {}): SendFacts => ({
  threadId: THREAD,
  kind: 'DIRECT',
  ownerId: VIEWER,
  locked: false,
  isMember: true,
  blocked: false,
  participantIds: [VIEWER, OTHER],
  ...overrides,
});

const createService = (
  options: {
    facts?: DirectPairFacts | null;
    send?: SendFacts | null;
    thread?: ConversationRecord | null;
    stored?: MessageRecord;
  } = {},
) => {
  const store = {
    // `??` would swallow an explicit null, and null is exactly the case under test:
    // the store answers null when the account is missing.
    directPairFacts: vi.fn(async () => ('facts' in options ? options.facts : pairFacts())),
    sendFacts: vi.fn(async () => (options.send === undefined ? sendFacts() : options.send)),
    ensureDirectThread: vi.fn(async () => conversation()),
    createGroupThread: vi.fn(async () => conversation({ kind: 'GROUP', title: 'Team' })),
    listConversations: vi.fn(async () => ({ items: [], hasMore: false, unreadThreads: 0 })),
    findConversation: vi.fn(async () =>
      options.thread === undefined ? conversation() : options.thread,
    ),
    // The stored message reflects the body the service handed over, so a test can
    // tell a trimmed body from the raw one.
    appendMessage: vi.fn(
      async (input: { body: string; clientId: string | null }) =>
        options.stored ?? message({ body: input.body, clientId: input.clientId }),
    ),
    listMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    findMessageByClientId: vi.fn(async () => null),
    markRead: vi.fn(async () => 0),
    unreadCount: vi.fn(async () => 3),
    addMembers: vi.fn(async () => []),
    removeMember: vi.fn(async () => true),
    updateGroup: vi.fn(async () => conversation({ kind: 'GROUP', title: 'Renamed' })),
    deleteMessage: vi.fn(async () => message({ deleted: true })),
  } satisfies ConversationStore;

  const hub = { publish: vi.fn() };
  const ids = { next: () => MESSAGE };
  const logger = { event: vi.fn() };

  const service = new MessagingService(
    store,
    hub,
    ids,
    logger as unknown as ConstructorParameters<typeof MessagingService>[3],
  );

  return { service, store, hub };
};

/** Asserts the promise rejects with the given domain error code. */
const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ error: { code } });
};

describe('messaging service: opening a direct conversation', () => {
  it('reuses an existing thread instead of creating a second one', async () => {
    const { service, store } = createService({
      facts: pairFacts({ threadId: THREAD, senderFollowsRecipient: false }),
    });

    const summary = await service.openDirect(VIEWER, OTHER);

    expect(summary.id).toBe(THREAD);
    expect(store.ensureDirectThread).toHaveBeenCalledWith({
      id: THREAD,
      ownerId: VIEWER,
      otherId: OTHER,
    });
  });

  /**
   * The three refusals must be indistinguishable to the caller: a "user not found"
   * that differs from "no relationship" turns the endpoint into an account oracle.
   */
  it('answers a missing account and a stranger identically', async () => {
    const missing = createService({ facts: null });
    await expectCode(missing.service.openDirect(VIEWER, OTHER), 'NOT_FOUND');
    expect(missing.store.ensureDirectThread).not.toHaveBeenCalled();

    const stranger = createService({
      facts: pairFacts({ senderFollowsRecipient: false, recipientFollowsSender: false }),
    });
    await expectCode(stranger.service.openDirect(VIEWER, OTHER), 'FORBIDDEN');
    expect(stranger.store.ensureDirectThread).not.toHaveBeenCalled();
  });

  it('lets a one-way follower open the conversation, and refuses a block first', async () => {
    const oneWay = createService({
      facts: pairFacts({ senderFollowsRecipient: true, recipientFollowsSender: false }),
    });
    await expect(oneWay.service.openDirect(VIEWER, OTHER)).resolves.toMatchObject({ id: THREAD });

    const blocked = createService({ facts: pairFacts({ blocked: true }) });
    await expectCode(blocked.service.openDirect(VIEWER, OTHER), 'FORBIDDEN');
  });

  it('refuses a conversation with yourself before reading any relationship', async () => {
    const { service, store } = createService();
    await expectCode(service.openDirect(VIEWER, VIEWER), 'VALIDATION_FAILED');
    expect(store.directPairFacts).not.toHaveBeenCalled();
  });
});

describe('messaging service: sending', () => {
  it('stores the trimmed body and fans out to the other participant', async () => {
    const { service, store, hub } = createService();

    const sent = await service.send(VIEWER, THREAD, { body: '  hi there  ' });

    expect(store.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'hi there', clientId: null }),
    );
    expect(sent.body).toBe('hi there');

    // The sender's own tabs get the message too, with no unread count.
    expect(hub.publish).toHaveBeenCalledWith(
      VIEWER,
      expect.objectContaining({ type: 'message', unreadCount: 0 }),
    );
    // The recipient's frame carries their own count, not the sender's.
    expect(hub.publish).toHaveBeenCalledWith(
      OTHER,
      expect.objectContaining({ type: 'message', unreadCount: 3 }),
    );
  });

  it('rejects an empty and an over-long body before touching the store', async () => {
    const { service, store } = createService();
    await expectCode(service.send(VIEWER, THREAD, { body: '   ' }), 'VALIDATION_FAILED');
    await expectCode(
      service.send(VIEWER, THREAD, { body: 'x'.repeat(4_001) }),
      'VALIDATION_FAILED',
    );
    expect(store.sendFacts).not.toHaveBeenCalled();
  });

  /** A block answers "not found": the caller is not told the thread still exists. */
  it('answers not found for a blocked or missing thread', async () => {
    const missing = createService({ send: null });
    await expectCode(missing.service.send(VIEWER, THREAD, { body: 'hi' }), 'NOT_FOUND');

    const blocked = createService({ send: sendFacts({ blocked: true }) });
    await expectCode(blocked.service.send(VIEWER, THREAD, { body: 'hi' }), 'NOT_FOUND');
  });

  it('refuses a locked conversation with a precondition, not a validation error', async () => {
    const { service } = createService({ send: sendFacts({ locked: true, kind: 'GROUP' }) });
    await expectCode(service.send(VIEWER, THREAD, { body: 'hi' }), 'PRECONDITION_FAILED');
  });
});

describe('messaging service: formatting', () => {
  it('titles a direct thread after the other participant', async () => {
    const { service } = createService();
    const summary = await service.conversation(VIEWER, THREAD);
    expect(summary.title).toBe('Grace');
    expect(summary.viewerIsOwner).toBe(false);
  });

  it('serves a placeholder instead of the body of a deleted message', async () => {
    const { service } = createService({ stored: message({ deleted: true }) });
    const sent = await service.send(VIEWER, THREAD, { body: 'gone' });
    expect(sent.body).toBe(DELETED_MESSAGE_PLACEHOLDER);
    expect(sent.deleted).toBe(true);
  });

  it('reverses a page of messages into reading order', async () => {
    const { service, store } = createService();
    store.listMessages.mockResolvedValueOnce({
      items: [message({ id: 'c' }), message({ id: 'b' }), message({ id: 'a' })],
      hasMore: true,
    });

    const page = await service.messages(VIEWER, THREAD, { limit: 3, before: null });
    expect(page.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    // The cursor is the oldest row on the page, because paging walks into the past.
    expect(page.nextCursor).toBe('a');
  });
});

describe('messaging service: groups', () => {
  it('refuses a group whose owner is also listed as a member', async () => {
    const { service, store } = createService();
    await expectCode(
      service.createGroup(VIEWER, { title: 'Team', memberIds: [OTHER, VIEWER] }),
      'VALIDATION_FAILED',
    );
    expect(store.createGroupThread).not.toHaveBeenCalled();
  });

  it('refuses a member who blocked the owner', async () => {
    const { service } = createService({ facts: pairFacts({ blocked: true }) });
    await expectCode(
      service.createGroup(VIEWER, { title: 'Team', memberIds: [OTHER] }),
      'FORBIDDEN',
    );
  });

  it('lets only the owner change the group', async () => {
    const notOwner = createService({ send: sendFacts({ kind: 'GROUP', ownerId: OTHER }) });
    await expectCode(notOwner.service.updateGroup(VIEWER, THREAD, { title: 'X' }), 'FORBIDDEN');

    const direct = createService({ send: sendFacts({ kind: 'DIRECT' }) });
    await expectCode(
      direct.service.updateGroup(VIEWER, THREAD, { title: 'X' }),
      'PRECONDITION_FAILED',
    );
  });

  it('refuses to leave a direct conversation', async () => {
    const { service } = createService();
    await expectCode(service.leave(VIEWER, THREAD), 'PRECONDITION_FAILED');
  });

  it('lets a member leave a group and notifies the remaining ones', async () => {
    const { service, store, hub } = createService({
      thread: conversation({ kind: 'GROUP', title: 'Team' }),
      send: sendFacts({ kind: 'GROUP' }),
    });

    await service.leave(VIEWER, THREAD);

    expect(store.removeMember).toHaveBeenCalledWith(THREAD, VIEWER);
    expect(hub.publish).toHaveBeenCalled();
  });
});
