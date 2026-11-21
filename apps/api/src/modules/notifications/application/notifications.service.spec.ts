/**
 * Notification service rules.
 *
 * These test what the service decides, not what the database does: that a blocked
 * or self-directed action produces nothing, that collapsing is the store's job but
 * the aggregate is what gets published, and that a failed write never propagates.
 */

import { describe, expect, it, vi } from 'vitest';

import { JsonLogger } from '../../../common/logging/logger.js';
import { NotificationsService } from './notifications.service.js';
import type { NotificationRecord, NotificationStore, RealtimeHub } from './ports.js';

const RECIPIENT = '0190f3c1-0000-7000-8000-000000000001';
const ACTOR = '0190f3c1-0000-7000-8000-000000000002';

const record = (overrides: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id: '0190f3c1-0000-7000-8000-0000000000aa',
  recipientId: RECIPIENT,
  kind: 'LIKE',
  actors: [{ accountId: ACTOR, username: 'ada', displayName: 'Ada', avatarKey: null }],
  actorCount: 1,
  subjectType: 'post',
  subjectId: '0190f3c1-0000-7000-8000-0000000000bb',
  preview: 'hello',
  read: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const createService = (options: { upsert?: NotificationRecord | null } = {}) => {
  const upsert = vi.fn(async () => (options.upsert === undefined ? record() : options.upsert));
  const store: NotificationStore = {
    upsert,
    list: vi.fn(async () => ({ items: [record()], hasMore: false, unreadCount: 1 })),
    unreadCount: vi.fn(async () => 1),
    markRead: vi.fn(async () => true),
    markAllRead: vi.fn(async () => 1),
    find: vi.fn(async () => record()),
  };
  const hub: RealtimeHub = { publish: vi.fn() };

  let counter = 0;
  const ids = { next: (): string => `id-${++counter}` };

  return {
    service: new NotificationsService(store, hub, ids, new JsonLogger('fatal')),
    store,
    hub,
    upsert,
  };
};

const context = { blocked: false, entitled: true };

const input = (
  overrides: Partial<Parameters<NotificationsService['notify']>[0]> = {},
): Parameters<NotificationsService['notify']>[0] => ({
  kind: 'LIKE',
  recipientId: RECIPIENT,
  actorId: ACTOR,
  groupKey: 'like:post-1',
  subjectType: 'post',
  subjectId: 'post-1',
  preview: 'hello',
  context,
  ...overrides,
});

describe('notify', () => {
  it('writes a row and publishes it', async () => {
    const { service, upsert, hub } = createService();
    const view = await service.notify(input());

    expect(upsert).toHaveBeenCalledOnce();
    expect(view?.kind).toBe('LIKE');
    expect(hub.publish).toHaveBeenCalledWith(
      RECIPIENT,
      expect.objectContaining({ type: 'notification' }),
    );
  });

  /** A block is checked before everything else, including the self-action rule. */
  it('writes nothing when the accounts are blocked', async () => {
    const { service, upsert } = createService();
    const view = await service.notify(input({ context: { blocked: true, entitled: true } }));

    expect(view).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('writes nothing for a self-directed action', async () => {
    const { service, upsert } = createService();
    expect(await service.notify(input({ actorId: RECIPIENT }))).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('writes nothing when the recipient is not entitled', async () => {
    const { service, upsert } = createService();
    const view = await service.notify(input({ context: { blocked: false, entitled: false } }));
    expect(view).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  /**
   * A like that was stored but could not be announced is a missing badge. Reporting
   * the like as failed would make the user retry and create a duplicate.
   */
  it('swallows a store failure instead of failing the caller', async () => {
    const { service, upsert } = createService();
    upsert.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.notify(input())).resolves.toBeNull();
  });

  it('truncates a preview to the excerpt length', async () => {
    const { service, upsert } = createService();
    await service.notify(input({ preview: 'x'.repeat(500) }));

    const written = upsert.mock.calls[0]?.[0] as { preview: string };
    expect([...written.preview].length).toBe(140);
    expect(written.preview.endsWith('…')).toBe(true);
  });

  it('leaves a short preview untouched and a null preview null', async () => {
    const { service, upsert } = createService();
    await service.notify(input({ preview: 'short' }));
    expect((upsert.mock.calls[0]?.[0] as { preview: string }).preview).toBe('short');

    await service.notify(input({ preview: null }));
    expect((upsert.mock.calls[1]?.[0] as { preview: string | null }).preview).toBeNull();
  });

  /** The badge is pushed with the row so a client never polls to keep it honest. */
  it('publishes the unread badge after the row', async () => {
    const { service, hub } = createService();
    await service.notify(input());

    expect(hub.publish).toHaveBeenLastCalledWith(RECIPIENT, {
      type: 'unread',
      unreadCount: 1,
      badge: '1',
    });
  });
});

describe('mentions', () => {
  const mentions = (
    overrides: Partial<Parameters<NotificationsService['notifyMentions']>[0]> = {},
  ) => ({
    body: 'thanks @ada and @grace, and @ada again',
    actorId: ACTOR,
    subjectType: 'post' as const,
    subjectId: 'post-9',
    resolve: async (username: string): Promise<string | null> =>
      ({ ada: RECIPIENT, grace: '0190f3c1-0000-7000-8000-000000000003' })[username] ?? null,
    contextFor: async () => context,
    ...overrides,
  });

  it('notifies each distinct mentioned account once', async () => {
    const { service, upsert } = createService();
    const sent = await service.notifyMentions(mentions());

    expect(sent).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('skips unknown usernames and the actor themselves', async () => {
    const { service, upsert } = createService();
    const sent = await service.notifyMentions(
      mentions({
        body: '@nobody @ada',
        actorId: RECIPIENT,
      }),
    );

    // `ada` resolves to the actor, and mentioning yourself is not a notification.
    expect(sent).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('collapses all mentions in one subject onto a single group key', async () => {
    const { service, upsert } = createService();
    await service.notifyMentions(mentions());

    const keys = upsert.mock.calls.map((call) => (call[0] as { groupKey: string }).groupKey);
    expect(new Set(keys)).toEqual(new Set(['mention:post-9']));
  });

  /** An email address in a body must not parse as a mention. */
  it('does not treat an email address as a mention', async () => {
    const { service, upsert } = createService();
    const sent = await service.notifyMentions(mentions({ body: 'write to ada@example.test' }));
    expect(sent).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('reading the inbox', () => {
  it('reports the unread badge with the cap applied', async () => {
    const { service, store } = createService();
    (store.unreadCount as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1_284);

    expect(await service.summary(RECIPIENT)).toEqual({
      unreadCount: 1_284,
      badge: '99+',
      badgeCap: 99,
    });
  });

  it('reports a foreign notification as missing', async () => {
    const { service, store } = createService();
    (store.markRead as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    await expect(service.markRead(RECIPIENT, 'nope')).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('publishes a zero badge after mark-all-read', async () => {
    const { service, hub } = createService();
    expect(await service.markAllRead(RECIPIENT)).toEqual({ unreadCount: 0 });
    expect(hub.publish).toHaveBeenCalledWith(RECIPIENT, {
      type: 'unread',
      unreadCount: 0,
      badge: '0',
    });
  });

  it('only advertises a next cursor when there is another page', async () => {
    const { service, store } = createService();
    const first = await service.list(RECIPIENT, { limit: 20, cursor: null, unreadOnly: false });
    expect(first.nextCursor).toBeNull();

    (store.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [record(), record({ id: '0190f3c1-0000-7000-8000-0000000000cc' })],
      hasMore: true,
      unreadCount: 2,
    });
    const second = await service.list(RECIPIENT, { limit: 2, cursor: null, unreadOnly: false });
    expect(second.nextCursor).toBe('0190f3c1-0000-7000-8000-0000000000cc');
  });
});
