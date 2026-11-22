'use client';

/**
 * Authenticated area layout.
 *
 * The guard lives here rather than in middleware because the access token is
 * in memory: middleware runs on the server, where that token does not exist. The
 * only credential the server can see is the HttpOnly refresh cookie, and using it
 * for routing decisions would mean a token refresh on every navigation.
 *
 * So the order is: render nothing until the session is known, then either the
 * shell or a redirect. "Render nothing" is a skeleton rather than a spinner — the
 * shell's shape is known, so preserving it avoids a jarring reflow on the way in.
 */

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { useSession } from '@/lib/session';

const ShellSkeleton = (): React.JSX.Element => (
  <div className="flex min-h-dvh flex-col bg-canvas">
    <div className="h-header border-b border-border bg-surface" />
    <div className="flex flex-1">
      <div className="hidden w-[260px] border-r border-border bg-surface lg:block" />
      <div className="flex-1 p-lg">
        <div className="skeleton mb-md h-8 w-56" />
        <div className="skeleton mb-sm h-24 w-full" />
        <div className="skeleton h-24 w-full" />
      </div>
    </div>
  </div>
);

export default function AppLayout({
  children,
}: {
  readonly children: ReactNode;
}): React.JSX.Element {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === 'anonymous') {
      // `next` preserves where the user was going, so signing in does not dump
      // them on the feed when they were heading somewhere specific.
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      router.replace(`/login?next=${next}`);
    }
  }, [router, status]);

  if (status !== 'authenticated') return <ShellSkeleton />;

  return <AppShell>{children}</AppShell>;
}
