/**
 * Home feed.
 *
 * This is the signed-in landing page: the composer plus the timeline. It is a
 * client component because the access token lives in memory, so the fetch cannot
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

  return (
    <div className="mx-auto flex max-w-[640px] flex-col gap-lg">
      <header className="flex flex-wrap items-end justify-between gap-sm">
        <div className="flex flex-col gap-xs">
          <h1 className="text-heading">Home</h1>
          <p className="text-body text-muted">
            Signed in as{' '}
            <span className="font-medium text-text">{session?.user.accountType ?? 'USER'}</span>.
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
