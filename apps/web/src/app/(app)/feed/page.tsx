/**
 * Home feed.
 *
 * This is the signed-in landing page — the composer plus the timeline. It lives at
 * `/feed` rather than `/` because `/` is the marketing page: one URL cannot be both a
 * sales pitch and a feed, and the version that resolved to the pitch for a signed-in
 * person was the more confusing of the two.
 *
 * It is a client component because the access token lives in memory, so the fetch cannot
 * happen on the server.
 */

'use client';

import Link from 'next/link';
import { UserRound } from 'lucide-react';

import { Timeline } from '@/components/feed/timeline';
import { buttonClass } from '@/components/ui/button-styles';
import { useSession } from '@/lib/session';

export default function HomePage(): React.JSX.Element {
  const { session } = useSession();
  const role = session?.user.accountType ?? 'USER';

  return (
    <div className="mx-auto flex max-w-[640px] flex-col gap-lg">
      <header className="flex flex-wrap items-end justify-between gap-sm">
        <div className="flex flex-col gap-xs">
          <h1 className="text-heading">Home</h1>
          {/*
            The account type ("USER", "STAFF") is an authorisation detail, not something a
            person needs to read about themselves — the earlier version printed "Signed in as
            USER", which answers a question nobody asked. Someone with extra permissions is
            worth telling, because it changes what they can see and do.
          */}
          <p className="text-body text-muted">
            {role === 'USER'
              ? 'What the people you follow are thinking about.'
              : `Signed in with ${role} access.`}
          </p>
        </div>
        <Link href="/settings/profile" className={buttonClass('secondary', 'sm')}>
          <UserRound aria-hidden className="size-4" />
          Edit profile
        </Link>
      </header>

      <Timeline />
    </div>
  );
}
