'use client';

/**
 * Loads the caller's own profile, then renders the edit form.
 *
 * The form is rendered from fetched server state rather than from the session
 * object: the session carries identity claims for routing, not profile data, and
 * using it here would mean editing a stale copy whenever the profile changed in
 * another tab.
 */

import { useEffect, useState } from 'react';
import type { ProfileResponse } from '@socialhub/contracts';

import { describeError } from '@/lib/form';
import { createProfileApi } from '@/lib/profile-api';
import { useSession } from '@/lib/session';
import { ProfileForm } from './profile-form';

export const ProfileSettingsView = (): React.JSX.Element => {
  const { client, status } = useSession();
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;

    let cancelled = false;
    createProfileApi(client)
      .getOwn()
      .then((result) => {
        if (!cancelled) setProfile(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(describeError(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [client, status]);

  if (error !== null) {
    return (
      <p role="alert" className="text-body text-danger">
        {error}
      </p>
    );
  }

  if (profile === null) {
    return (
      <div className="flex max-w-[640px] flex-col gap-md" aria-busy>
        <div className="skeleton h-6 w-40" />
        <div className="skeleton h-10 w-full" />
        <div className="skeleton h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex flex-col gap-xs">
        <h1 className="text-subheading font-semibold text-text">Edit profile</h1>
        <p className="text-small text-muted">This is how other people see you on SocialHub.</p>
      </div>
      <ProfileForm profile={profile} onSaved={setProfile} />
    </div>
  );
};
