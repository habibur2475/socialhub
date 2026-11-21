/**
 * Profile component behaviour.
 *
 * The tests target the two decisions a user can actually feel: what a redacted
 * profile looks like, and what the follow button promises. Both are places where a
 * plausible-looking implementation quietly lies — rendering a hidden bio as empty,
 * or showing "Following" for a request that was only sent.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProfileResponse } from '@socialhub/contracts';

import { SessionProvider } from '@/lib/session';
import { FollowButton } from './follow-button';
import { ProfileHeader } from './profile-header';

/**
 * `FollowButton` reads the shared client from the session context, so it must be
 * rendered inside the provider — the same requirement as in the app.
 */
const withSession = (ui: React.ReactElement): React.JSX.Element => (
  <SessionProvider>{ui}</SessionProvider>
);

const profile = (overrides: Partial<ProfileResponse> = {}): ProfileResponse => ({
  accountId: '0190f3c1-0000-7000-8000-000000000001',
  username: 'ada',
  displayName: 'Ada Lovelace',
  bio: 'Mathematician',
  avatarKey: null,
  bannerKey: null,
  followerCount: 12,
  followingCount: 5,
  createdAt: '2026-01-01T00:00:00.000Z',
  isSelf: false,
  isFollowing: false,
  followPending: false,
  isBlocked: false,
  canFollow: true,
  canMessage: false,
  ...overrides,
});

describe('profile header', () => {
  it('renders the display name as a level-one heading', () => {
    render(<ProfileHeader profile={profile()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Ada Lovelace' })).toBeDefined();
    expect(screen.getByText('@ada')).toBeDefined();
  });

  it('shows a redacted profile as restricted rather than blank', () => {
    render(
      <ProfileHeader profile={profile({ bio: null, followerCount: null, followingCount: null })} />,
    );

    // The distinction matters: an empty profile and a hidden one look identical
    // otherwise, and the reader concludes there is nothing to see.
    expect(screen.getByText(/restricted/i)).toBeDefined();
    // A hidden count is a dash, not an omitted element.
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('shows a bio with its line breaks preserved', () => {
    render(<ProfileHeader profile={profile({ bio: 'line one\nline two' })} />);
    const bio = screen.getByText(/line one/);
    expect(bio.className).toContain('whitespace-pre-line');
  });

  it('renders counts with locale grouping', () => {
    render(<ProfileHeader profile={profile({ followerCount: 12000 })} />);
    expect(screen.getByText('12,000')).toBeDefined();
  });
});

describe('follow button', () => {
  const renderButton = (
    state: { isFollowing?: boolean; followPending?: boolean },
    response: () => Promise<Response>,
  ) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(response));
    const onChanged = vi.fn();
    render(
      withSession(
        <FollowButton
          accountId={profile().accountId}
          isFollowing={state.isFollowing ?? false}
          followPending={state.followPending ?? false}
          onChanged={onChanged}
        />,
      ),
    );
    return { onChanged };
  };

  it('reports an accepted follow to the caller', async () => {
    const { onChanged } = renderButton({}, async () =>
      Response.json({ following: true }, { status: 200 }),
    );

    fireEvent.click(screen.getByRole('button', { name: /follow/i }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledWith({ isFollowing: true, followPending: false });
    });
  });

  /**
   * A private account answers `{ following: false }`. Treating that as an error, or
   * as an accepted follow, both mislead the user; the correct reading is "requested".
   */
  it('treats a non-accepted follow as a pending request', async () => {
    const { onChanged } = renderButton({}, async () =>
      Response.json({ following: false }, { status: 200 }),
    );

    fireEvent.click(screen.getByRole('button', { name: /follow/i }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledWith({ isFollowing: false, followPending: true });
    });
  });

  it('labels a pending request differently from an accepted follow', () => {
    render(<ProfileHeader profile={profile()} />);
    render(
      withSession(
        <FollowButton
          accountId={profile().accountId}
          isFollowing={false}
          followPending
          onChanged={() => undefined}
        />,
      ),
    );
    expect(screen.getByRole('button', { name: 'Requested' })).toBeDefined();
  });

  it('shows an error and does not report success when the request fails', async () => {
    const { onChanged } = renderButton({}, async () =>
      Response.json(
        { error: { code: 'NOT_FOUND', message: 'Profile not found' } },
        { status: 404 },
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /follow/i }));

    expect(await screen.findByRole('alert')).toBeDefined();
    // The UI must not claim a follow the server refused.
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('unfollows when already following', async () => {
    const { onChanged } = renderButton(
      { isFollowing: true },
      async () => new Response(null, { status: 204 }),
    );

    fireEvent.click(screen.getByRole('button', { name: /following/i }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledWith({ isFollowing: false, followPending: false });
    });
  });

  it('exposes the toggle state to assistive technology', () => {
    renderButton({ isFollowing: true }, async () => new Response(null, { status: 204 }));
    expect(screen.getByRole('button', { name: /following/i }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});
