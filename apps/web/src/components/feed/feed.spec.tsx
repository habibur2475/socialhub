/**
 * Feed component behaviour.
 *
 * The tests target the decisions a user can feel: that the composer cannot submit
 * an empty post, that the counter agrees with the server, that a like is
 * optimistic but rolls back on failure, and that only the author sees a delete
 * action.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PostResponse } from '@socialhub/contracts';

import { SessionProvider } from '@/lib/session';
import { PostCard } from './post-card';
import { PostComposer } from './post-composer';

const post = (overrides: Partial<PostResponse> = {}): PostResponse => ({
  id: '0190f3c1-0000-7000-8000-0000000000c1',
  author: {
    accountId: '0190f3c1-0000-7000-8000-00000000000a',
    username: 'ada',
    displayName: 'Ada Lovelace',
    avatarKey: null,
  },
  body: 'Hello from the test suite',
  visibility: 'PUBLIC',
  likeCount: 0,
  replyCount: 0,
  repostCount: 0,
  likedByMe: false,
  replyTo: null,
  repostOf: null,
  editedAt: null,
  createdAt: '2026-01-15T11:55:00.000Z',
  ...overrides,
});

const withSession = (ui: React.ReactElement): React.JSX.Element => (
  <SessionProvider>{ui}</SessionProvider>
);

const NOW = new Date('2026-01-15T12:00:00.000Z');

describe('post composer', () => {
  it('cannot submit an empty post', () => {
    render(withSession(<PostComposer onPublished={() => undefined} />));
    const submit = screen.getByRole('button', { name: /^post$/i });
    expect(submit).toHaveProperty('disabled', true);
  });

  it('enables submission once there is text', () => {
    render(withSession(<PostComposer onPublished={() => undefined} />));
    fireEvent.change(screen.getByLabelText(/post text/i), { target: { value: 'hi' } });
    expect(screen.getByRole('button', { name: /^post$/i })).toHaveProperty('disabled', false);
  });

  /**
   * The counter must agree with the validator. A counter that counts UTF-16 units
   * shows a different number than the server measures, so it can read "5 left"
   * and still refuse the post.
   */
  it('counts code points, so an emoji costs one', () => {
    render(withSession(<PostComposer onPublished={() => undefined} />));
    fireEvent.change(screen.getByLabelText(/post text/i), { target: { value: '🚀🚀🚀' } });

    // 5000 - 3, not 5000 - 6.
    expect(screen.getByText('4997')).toBeDefined();
  });

  it('posts the body and clears the composer on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => Response.json(post(), { status: 201 })),
    );
    const onPublished = vi.fn();

    render(withSession(<PostComposer onPublished={onPublished} />));
    fireEvent.change(screen.getByLabelText(/post text/i), { target: { value: 'first post' } });
    fireEvent.click(screen.getByRole('button', { name: /^post$/i }));

    await waitFor(() => {
      expect(onPublished).toHaveBeenCalled();
    });
    expect((screen.getByLabelText(/post text/i) as HTMLTextAreaElement).value).toBe('');
  });

  it('keeps the draft when the server rejects the post', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          Response.json(
            { error: { code: 'VALIDATION_FAILED', message: 'Write something first' } },
            { status: 422 },
          ),
        ),
    );

    render(withSession(<PostComposer onPublished={() => undefined} />));
    fireEvent.change(screen.getByLabelText(/post text/i), { target: { value: 'keep me' } });
    fireEvent.click(screen.getByRole('button', { name: /^post$/i }));

    expect(await screen.findByRole('alert')).toBeDefined();
    // Losing what someone wrote is worse than any error message.
    expect((screen.getByLabelText(/post text/i) as HTMLTextAreaElement).value).toBe('keep me');
  });
});

describe('post card', () => {
  it('renders the author, body and relative time', () => {
    render(
      withSession(<PostCard post={post()} now={NOW} isOwn={false} onChanged={() => undefined} />),
    );

    expect(screen.getByText('Ada Lovelace')).toBeDefined();
    expect(screen.getByText('@ada')).toBeDefined();
    expect(screen.getByText('Hello from the test suite')).toBeDefined();
    expect(screen.getByText('5 minutes ago')).toBeDefined();
  });

  it('exposes the exact timestamp in the datetime attribute', () => {
    render(
      withSession(<PostCard post={post()} now={NOW} isOwn={false} onChanged={() => undefined} />),
    );
    const time = screen.getByText('5 minutes ago');
    expect(time.getAttribute('datetime')).toBe('2026-01-15T11:55:00.000Z');
  });

  it('labels a non-public post', () => {
    render(
      withSession(
        <PostCard
          post={post({ visibility: 'FOLLOWERS' })}
          now={NOW}
          isOwn={false}
          onChanged={() => undefined}
        />,
      ),
    );
    expect(screen.getByText('Followers')).toBeDefined();
  });

  it('shows the delete action only to the author', () => {
    const { unmount } = render(
      withSession(<PostCard post={post()} now={NOW} isOwn={false} onChanged={() => undefined} />),
    );
    expect(screen.queryByRole('button', { name: /post actions/i })).toBeNull();
    unmount();

    render(withSession(<PostCard post={post()} now={NOW} isOwn onChanged={() => undefined} />));
    expect(screen.getByRole('button', { name: /post actions/i })).toBeDefined();
  });

  it('likes optimistically and reports the server count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => Response.json({ liked: true, likeCount: 1 })),
    );

    render(
      withSession(<PostCard post={post()} now={NOW} isOwn={false} onChanged={() => undefined} />),
    );
    const like = screen.getByRole('button', { name: /likes/i });

    fireEvent.click(like);
    // Optimistic: the count moves before the response arrives.
    expect(like.textContent).toContain('1');
    await waitFor(() => {
      expect(like.getAttribute('aria-pressed')).toBe('true');
    });
  });

  /**
   * A like that never reached the server must not stay lit. The rollback restores
   * the captured previous state rather than recomputing it.
   */
  it('rolls the like back when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async () =>
          Response.json(
            { error: { code: 'NOT_FOUND', message: 'Post not found' } },
            { status: 404 },
          ),
        ),
    );

    render(
      withSession(
        <PostCard
          post={post({ likeCount: 7 })}
          now={NOW}
          isOwn={false}
          onChanged={() => undefined}
        />,
      ),
    );

    const like = screen.getByRole('button', { name: /likes/i });
    fireEvent.click(like);

    expect(await screen.findByRole('alert')).toBeDefined();
    await waitFor(() => {
      expect(like.getAttribute('aria-pressed')).toBe('false');
    });
    expect(like.textContent).toContain('7');
  });

  it('opens a reply composer inline', () => {
    render(
      withSession(<PostCard post={post()} now={NOW} isOwn={false} onChanged={() => undefined} />),
    );
    fireEvent.click(screen.getByRole('button', { name: /replies/i }));
    expect(screen.getByLabelText(/post text/i)).toBeDefined();
  });
});
