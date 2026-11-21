/**
 * Forum service rules.
 *
 * What the service decides rather than what the database enforces: who may accept an
 * answer, who may delete one, and that a locked thread refuses new answers before the
 * insert is attempted.
 */

import { describe, expect, it, vi } from 'vitest';

import { ForumService } from './forum.service.js';
import type { ForumAnswerRecord, ForumStore, ForumThreadRecord } from './ports.js';

const AUTHOR = '0190f3c1-0000-7000-8000-00000000000a';
const OTHER = '0190f3c1-0000-7000-8000-00000000000b';
const THREAD = '0190f3c1-0000-7000-8000-0000000000d1';
const ANSWER = '0190f3c1-0000-7000-8000-0000000000e1';

const thread = (overrides: Partial<ForumThreadRecord> = {}): ForumThreadRecord => ({
  id: THREAD,
  categoryId: '0190f3c1-0000-7000-8000-0000000000c1',
  categoryPath: '/general',
  authorId: AUTHOR,
  author: { accountId: AUTHOR, username: 'ada', displayName: 'Ada', avatarKey: null },
  title: 'How do I rotate a token?',
  body: 'The docs are unclear.',
  answerCount: 0,
  pinned: false,
  locked: false,
  hasAcceptedAnswer: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const answer = (overrides: Partial<ForumAnswerRecord> = {}): ForumAnswerRecord => ({
  id: ANSWER,
  threadId: THREAD,
  authorId: OTHER,
  author: { accountId: OTHER, username: 'grace', displayName: 'Grace', avatarKey: null },
  body: 'Call the rotate endpoint with the old token.',
  accepted: false,
  createdAt: new Date('2026-01-01T01:00:00.000Z'),
  ...overrides,
});

const createService = (
  options: { thread?: ForumThreadRecord | null; answer?: ForumAnswerRecord | null } = {},
) => {
  const threadRecord = options.thread === undefined ? thread() : options.thread;
  const answerRecord = options.answer === undefined ? answer() : options.answer;

  const store: ForumStore = {
    listCategories: vi.fn(async () => []),
    findCategoryByPath: vi.fn(async () => ({
      id: '0190f3c1-0000-7000-8000-0000000000c1',
      slug: 'general',
      name: 'General',
      path: '/general',
      threadCount: 0,
    })),
    findCategoryById: vi.fn(async () => ({
      id: '0190f3c1-0000-7000-8000-0000000000c1',
      slug: 'general',
      name: 'General',
      path: '/general',
      threadCount: 0,
    })),
    findThread: vi.fn(async () => threadRecord),
    listThreads: vi.fn(async () => ({
      items: threadRecord === null ? [] : [threadRecord],
      hasMore: false,
    })),
    createThread: vi.fn(async () => threadRecord),
    listAnswers: vi.fn(async () => ({ items: [answerRecord], hasMore: false })),
    createAnswer: vi.fn(async () => answerRecord),
    acceptAnswer: vi.fn(async () => answerRecord),
    canAccept: vi.fn(async () => true),
    threadAuthorId: vi.fn(async () => AUTHOR),
    answerOwner: vi.fn(async () => ({ threadId: THREAD, authorId: OTHER })),
    deleteAnswer: vi.fn(async () => true),
    isThreadLocked: vi.fn(async () => threadRecord?.locked === true),
  };

  const notifications = { notify: vi.fn(async () => null), notifyMentions: vi.fn(async () => 0) };
  const profiles = { findByUsername: vi.fn(async () => null) };
  const graph = { isBlockedEitherWay: vi.fn(async () => false) };

  let counter = 0;
  const ids = { next: (): string => `id-${++counter}` };

  return {
    service: new ForumService(
      store,
      notifications as never,
      profiles as never,
      graph as never,
      ids,
    ),
    store,
    notifications,
  };
};

describe('threads', () => {
  it('rejects a thread in a category that does not exist', async () => {
    const { service, store } = createService();
    (store.findCategoryById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(
      service.createThread(AUTHOR, {
        categoryId: '0190f3c1-0000-7000-8000-0000000000ff',
        title: 'A title',
        body: 'Body',
      }),
    ).rejects.toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('reports an invisible thread as missing', async () => {
    const { service } = createService({ thread: null });
    await expect(
      service.threadDetail(OTHER, THREAD, { limit: 50, cursor: null }),
    ).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  /** A locked thread is how a moderator stops a bad discussion without deleting it. */
  it('refuses an answer on a locked thread', async () => {
    const { service, store } = createService({ thread: thread({ locked: true }) });
    await expect(service.createAnswer(OTHER, THREAD, { body: 'late' })).rejects.toMatchObject({
      error: { code: 'PRECONDITION_FAILED' },
    });
    expect(store.createAnswer).not.toHaveBeenCalled();
  });

  it('reports a lost race on a locked thread as the same refusal', async () => {
    const { service } = createService({ answer: null });
    await expect(service.createAnswer(OTHER, THREAD, { body: 'late' })).rejects.toMatchObject({
      error: { code: 'PRECONDITION_FAILED' },
    });
  });

  it('notifies the thread author about an answer, collapsed per thread', async () => {
    const { service, notifications } = createService();
    await service.createAnswer(OTHER, THREAD, { body: 'here is the answer' });

    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'THREAD_ANSWER',
        recipientId: AUTHOR,
        actorId: OTHER,
        groupKey: `thread-answer:${THREAD}`,
        subjectType: 'thread',
      }),
    );
  });

  it('does not notify an author who answered their own thread', async () => {
    const { service, notifications } = createService();
    await service.createAnswer(AUTHOR, THREAD, { body: 'adding detail' });

    // The decision function would refuse this anyway; skipping it here avoids the
    // block lookup that the decision needs.
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});

describe('accepting an answer', () => {
  it('lets the thread author accept', async () => {
    const { service, store } = createService({
      answer: answer({ accepted: true }),
    });

    const result = await service.acceptAnswer(AUTHOR, THREAD, ANSWER);
    expect(result.accepted).toBe(true);
    expect(store.acceptAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD, answerId: ANSWER, threadAuthorId: AUTHOR }),
    );
  });

  /** An endorsement that anyone can give is not an endorsement. */
  it('refuses a non-author, reporting the answer as missing', async () => {
    const { service, store } = createService();
    await expect(service.acceptAnswer(OTHER, THREAD, ANSWER)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(store.acceptAnswer).not.toHaveBeenCalled();
  });

  it('reports an answer from another thread as missing', async () => {
    const { service } = createService({ answer: null });
    await expect(service.acceptAnswer(AUTHOR, THREAD, ANSWER)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('deleting an answer', () => {
  it('lets the answer author delete their own answer', async () => {
    const { service, store } = createService();
    await service.deleteAnswer(OTHER, ANSWER);
    expect(store.deleteAnswer).toHaveBeenCalledWith(ANSWER, OTHER);
  });

  /** The thread author may moderate an answer on their own thread. */
  it('lets the thread author moderate an answer', async () => {
    const { service, store } = createService();
    await service.deleteAnswer(AUTHOR, ANSWER);
    // The delete runs as the answer's author so the store's ownership clause holds.
    expect(store.deleteAnswer).toHaveBeenCalledWith(ANSWER, OTHER);
  });

  it('refuses a stranger', async () => {
    const { service, store } = createService();
    (store.threadAuthorId as ReturnType<typeof vi.fn>).mockResolvedValueOnce('someone-else');

    await expect(service.deleteAnswer('stranger', ANSWER)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(store.deleteAnswer).not.toHaveBeenCalled();
  });

  it('reports a missing answer as not found', async () => {
    const { service, store } = createService();
    (store.answerOwner as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(service.deleteAnswer(OTHER, ANSWER)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('shaping', () => {
  it('lets only the thread author accept, and only until an answer is accepted', async () => {
    const mine = createService();
    expect(
      (await mine.service.threadDetail(AUTHOR, THREAD, { limit: 50, cursor: null })).thread
        .canAcceptAnswer,
    ).toBe(true);

    const theirs = createService();
    expect(
      (await theirs.service.threadDetail(OTHER, THREAD, { limit: 50, cursor: null })).thread
        .canAcceptAnswer,
    ).toBe(false);

    const accepted = createService({ thread: thread({ hasAcceptedAnswer: true }) });
    expect(
      (await accepted.service.threadDetail(AUTHOR, THREAD, { limit: 50, cursor: null })).thread
        .canAcceptAnswer,
    ).toBe(false);
  });

  it('marks an answer deletable only for its own author', async () => {
    const mine = createService();
    const detail = await mine.service.threadDetail(OTHER, THREAD, { limit: 50, cursor: null });
    expect(detail.answers[0]?.canDelete).toBe(true);

    const theirs = await mine.service.threadDetail(AUTHOR, THREAD, { limit: 50, cursor: null });
    expect(theirs.answers[0]?.canDelete).toBe(false);
  });
});
