/**
 * Feed service rules.
 *
 * The database owns visibility, so these tests focus on what the service decides:
 * what may be written, how a reply inherits its parent's audience, when an
 * audience snapshot is taken, and that ownership never leaks through an error.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PostAudience } from '@socialhub/kernel';

import { FeedService } from './feed.service.js';
import type { PostRecord, PostStore, TimelinePage } from './ports.js';

const AUTHOR = '0190f3c1-0000-7000-8000-00000000000a';
const VIEWER = '0190f3c1-0000-7000-8000-00000000000b';
const POST = '0190f3c1-0000-7000-8000-0000000000c1';

const post = (overrides: Partial<PostRecord> = {}): PostRecord => ({
  id: POST,
  authorId: AUTHOR,
  body: 'hello world',
  visibility: 'PUBLIC',
  likeCount: 0,
  replyCount: 0,
  repostCount: 0,
  replyTo: null,
  repostOf: null,
  editedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  author: { accountId: AUTHOR, username: 'ada', displayName: 'Ada', avatarKey: null },
  likedByMe: false,
  ...overrides,
});

const emptyPage: TimelinePage = { items: [], hasMore: false };

const createService = (
  options: { existing?: PostRecord | null; canView?: boolean; page?: TimelinePage } = {},
) => {
  const existing = options.existing === undefined ? post() : options.existing;
  const page = options.page ?? emptyPage;

  const create = vi.fn(async (input: Parameters<PostStore['create']>[0]) =>
    post({ body: input.body, visibility: input.visibility, replyTo: input.replyTo }),
  );

  const store: PostStore = {
    find: vi.fn(async () => existing),
    create,
    updateBody: vi.fn(async () => existing),
    remove: vi.fn(async () => true),
    homeTimeline: vi.fn(async () => page),
    authorTimeline: vi.fn(async () => page),
    setLike: vi.fn(async () => true),
    acceptedFollowerIds: vi.fn(async () => [VIEWER]),
    canView: vi.fn(async () => options.canView ?? true),
  };

  let counter = 0;
  const ids = {
    next: (): string => `0190f3c1-0000-7000-8000-${String(++counter).padStart(12, '0')}`,
  };

  return { service: new FeedService(store, ids), store };
};

describe('creating a post', () => {
  it('trims the body and publishes public by default', async () => {
    const { service, store } = createService();
    const view = await service.createPost(AUTHOR, { body: '  hi  ', visibility: 'PUBLIC' });

    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'hi', visibility: 'PUBLIC', replyTo: null }),
    );
    expect(view.body).toBe('hi');
  });

  it('rejects an empty body', async () => {
    const { service, store } = createService();
    await expect(
      service.createPost(AUTHOR, { body: '   ', visibility: 'PUBLIC' }),
    ).rejects.toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(store.create).not.toHaveBeenCalled();
  });

  /**
   * The audience is a snapshot taken at publication. A follower gained later was
   * not part of the audience the author addressed, so the store must be told the
   * follower list as it is *now*.
   */
  it('snapshots the accepted followers for a FOLLOWERS post', async () => {
    const { service, store } = createService();
    await service.createPost(AUTHOR, { body: 'members only', visibility: 'FOLLOWERS' });

    expect(store.acceptedFollowerIds).toHaveBeenCalledWith(AUTHOR);
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ audienceAccountIds: [VIEWER] }),
    );
  });

  it('writes no audience rows for a public or private post', async () => {
    const { service, store } = createService();

    await service.createPost(AUTHOR, { body: 'everyone', visibility: 'PUBLIC' });
    await service.createPost(AUTHOR, { body: 'just me', visibility: 'PRIVATE' });

    expect(store.acceptedFollowerIds).not.toHaveBeenCalled();
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ audienceAccountIds: [] }));
  });
});

describe('replying', () => {
  it('narrows a public reply to a followers-only parent', async () => {
    const { service, store } = createService({
      existing: post({ id: POST, visibility: 'FOLLOWERS' }),
    });

    await service.createPost(VIEWER, { body: 'a reply', visibility: 'PUBLIC', replyTo: POST });

    // Otherwise the reply text could be read by everyone the parent was hidden
    // from, disclosing the parent by implication.
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'FOLLOWERS' }));
  });

  it('narrows a reply to a private parent to PRIVATE', async () => {
    const { service, store } = createService({
      existing: post({ id: POST, visibility: 'PRIVATE' }),
    });

    await service.createPost(AUTHOR, { body: 'note to self', visibility: 'PUBLIC', replyTo: POST });

    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'PRIVATE' }));
  });

  /**
   * Replying to something invisible is reported as missing, not forbidden: a
   * distinguishable denial confirms the post exists.
   */
  it('reports an invisible parent as missing', async () => {
    const { service, store } = createService({ existing: post(), canView: false });

    await expect(
      service.createPost(VIEWER, { body: 'reply', visibility: 'PUBLIC', replyTo: POST }),
    ).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('reports a missing parent as missing', async () => {
    const { service } = createService({ existing: null });
    await expect(
      service.createPost(VIEWER, { body: 'reply', visibility: 'PUBLIC', replyTo: POST }),
    ).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('likes', () => {
  it('returns the resulting state rather than an acknowledgement', async () => {
    const { service, store } = createService({
      existing: post({ likeCount: 4, likedByMe: true }),
    });

    await expect(service.setLike(VIEWER, POST, true)).resolves.toEqual({
      liked: true,
      likeCount: 4,
    });
    expect(store.setLike).toHaveBeenCalledWith(POST, VIEWER, true);
  });

  it('refuses to like a post the viewer cannot see', async () => {
    const { service, store } = createService({ canView: false });

    await expect(service.setLike(VIEWER, POST, true)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(store.setLike).not.toHaveBeenCalled();
  });
});

describe('editing and deleting', () => {
  it('edits a body the caller owns', async () => {
    const { service, store } = createService();
    const view = await service.editPost(AUTHOR, POST, '  revised  ');
    expect(store.updateBody).toHaveBeenCalledWith(POST, AUTHOR, 'revised');
    expect(view).toBeDefined();
  });

  it('reports someone else’s post as missing rather than forbidden', async () => {
    const { service, store } = createService();
    vi.mocked(store.updateBody).mockResolvedValue(null);

    // Ownership must not be learnable from the error code.
    await expect(service.editPost(VIEWER, POST, 'hijack')).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('rejects an empty edit before touching the store', async () => {
    const { service, store } = createService();
    await expect(service.editPost(AUTHOR, POST, '   ')).rejects.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(store.updateBody).not.toHaveBeenCalled();
  });

  it('reports a delete of a post the caller does not own as missing', async () => {
    const { service, store } = createService();
    vi.mocked(store.remove).mockResolvedValue(false);

    await expect(service.deletePost(VIEWER, POST)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('reading', () => {
  it('reports a post the viewer may not see as missing', async () => {
    const { service } = createService({ canView: false });
    await expect(service.getPost(VIEWER, POST)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('keeps the cursor null when the page is not full', async () => {
    const { service } = createService({
      page: { items: [post()], hasMore: false },
    });
    const timeline = await service.homeTimeline(VIEWER, { limit: 20, cursor: null });
    expect(timeline.nextCursor).toBeNull();
  });

  it('points the cursor at the last post when more exist', async () => {
    const { service } = createService({
      page: { items: [post({ id: POST })], hasMore: true },
    });
    const timeline = await service.homeTimeline(VIEWER, { limit: 1, cursor: null });
    expect(timeline.nextCursor).toBe(POST);
  });

  it('serialises dates as ISO strings, not Date objects', async () => {
    const { service } = createService({ page: { items: [post()], hasMore: false } });
    const timeline = await service.homeTimeline(VIEWER, { limit: 20, cursor: null });
    expect(timeline.items[0]?.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
