/**
 * Work: the freelance board.
 *
 * `useSearchParams` needs a Suspense boundary or the whole route becomes dynamic; the boundary
 * wraps only the grid, so the heading is part of the first paint.
 */

'use client';

import { Suspense } from 'react';

import { JobBoard } from '@/components/work/job-board';

export default function WorkPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <h1 className="text-heading">Work</h1>
        <p className="max-w-[60ch] text-body text-muted">
          Freelance jobs, with the money held in escrow until the work is approved. Post what you
          need done, or bid on what somebody else needs.
        </p>
      </header>

      <Suspense
        fallback={
          <div className="flex flex-col gap-sm" aria-busy>
            <div className="skeleton h-10 w-full" />
            <div className="skeleton h-20 w-full" />
            <div className="skeleton h-20 w-full" />
          </div>
        }
      >
        <JobBoard />
      </Suspense>
    </div>
  );
}
