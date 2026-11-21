/**
 * Forum index.
 *
 * `useSearchParams` requires a Suspense boundary in the App Router: without one, the
 * page is forced dynamic and Next warns at build time. The boundary wraps only the list,
 * so the heading renders immediately.
 */

'use client';

import Link from 'next/link';
import { Suspense } from 'react';
import { Plus } from 'lucide-react';

import { ForumList } from '@/components/forum/forum-list';
import { buttonClass } from '@/components/ui/button-styles';

export default function ForumPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-lg">
      <header className="flex flex-wrap items-end justify-between gap-sm">
        <div className="flex flex-col gap-xs">
          <h1 className="text-heading">Forum</h1>
          <p className="text-body text-muted">
            Threaded discussion by topic. Answers can be accepted, so the useful one stays at the
            top.
          </p>
        </div>
        <Link href="/forum/new" className={buttonClass('primary', 'sm')}>
          <Plus aria-hidden className="size-4" />
          New thread
        </Link>
      </header>

      <Suspense
        fallback={
          <div className="flex flex-col gap-sm" aria-busy>
            <div className="skeleton h-9 w-full" />
            <div className="skeleton h-20 w-full" />
          </div>
        }
      >
        <ForumList />
      </Suspense>
    </div>
  );
}
