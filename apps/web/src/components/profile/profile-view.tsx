'use client';

/**
 * Public profile view.
 *
 * The page fetches nothing on the server because the access token lives in
 * memory: a server-rendered profile would have to be fetched with the refresh
 * cookie, which is exactly the credential the architecture keeps away from
 * routing. So the fetch is client-side, and the skeleton preserves the layout
 * while it resolves.
 *
 * A 404 is rendered as "not found" rather than an error, because that is what the
 * API deliberately returns for a blocked account too — the client must not be able
 * to tell the difference, or the block becomes visible.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ProfileResponse } from '@socialhub/contracts';

import { isApiFailure } from '@/lib/api-client';
import { describeError } from '@/lib/form';
import { createProfileApi } from '@/lib/profile-api';
import { useSession } from '@/lib/session';
import { Timeline } from '@/components/feed/timeline';
import { MessageButton } from '@/components/messaging/message-button';
import { FollowButton } from './follow-button';
import { ProfileHeader } from './profile-header';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly profile: ProfileResponse }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly message: string };

export const ProfileView = ({ username }: { readonly username: string }): React.JSX.Element => {
  const { client, status } = useSession();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    // The guard in the layout redirects anonymous visitors; fetching before the
    // token exists would only produce a guaranteed 401.
    if (status !== 'authenticated') return;

    let cancelled = false;

    createProfileApi(client)
      .getByUsername(username)
      .then((profile) => {
        if (!cancelled) setState({ kind: 'ready', profile });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (isApiFailure(cause) && cause.status === 404) {
          setState({ kind: 'missing' });
          return;
        }
        setState({ kind: 'error', message: describeError(cause) });
      });

    return () => {
      cancelled = true;
    };
  }, [client, status, username]);

  const onChanged = useCallback((next: { isFollowing: boolean; followPending: boolean }) => {
    setState((current) =>
      current.kind === 'ready'
        ? { kind: 'ready', profile: { ...current.profile, ...next } }
        : current,
    );
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="flex flex-col gap-md" aria-busy>
        <div className="skeleton h-[72px] w-[72px] rounded-full" />
        <div className="skeleton h-6 w-48" />
        <div className="skeleton h-4 w-32" />
      </div>
    );
  }

  if (state.kind === 'missing') {
    return (
      <div className="flex flex-col gap-xs">
        <h1 className="text-subheading font-semibold text-text">Profile not found</h1>
        <p className="text-body text-muted">
          This account does not exist, or it is not available to you.
        </p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <p role="alert" className="text-body text-danger">
        {state.message}
      </p>
    );
  }

  const { profile } = state;

  return (
    <div className="flex flex-col gap-lg">
      <ProfileHeader
        profile={profile}
        {...(profile.isSelf || !profile.canFollow
          ? {}
          : {
              // Follow and Message sit together: both are "reach this person", and a
              // profile that can be followed but not messaged is a dead end.
              action: (
                <div className="flex items-center gap-xs">
                  <MessageButton accountId={profile.accountId} />
                  <FollowButton
                    accountId={profile.accountId}
                    isFollowing={profile.isFollowing}
                    followPending={profile.followPending}
                    onChanged={onChanged}
                  />
                </div>
              ),
            })}
      />

      {/* The timeline applies the same visibility rule as the header, so a
          restricted profile shows no posts rather than a blank section. */}
      <Timeline username={username} showComposer={false} emptyMessage="No posts yet." />
    </div>
  );
};
