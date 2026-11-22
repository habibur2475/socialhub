'use client';

/**
 * The job board.
 *
 * Three views, all URL state so each one is a link somebody can send: jobs taking proposals,
 * the jobs I posted, and my own proposals. „My proposals" is not a fourth endpoint — it is the
 * board with `mine` unset, filtered by the `hasProposed` flag the server already sends, because
 * a freelancer's bids are rows on jobs that still belong to their clients.
 *
 * The card shows `proposalCount` but never the proposals themselves. A freelancer deciding
 * whether to bid should know there are eleven others; they should not know what those eleven
 * are charging.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Briefcase, Plus, Search } from 'lucide-react';

import type { JobSummaryResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { Input } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createWorkApi } from '@/lib/work-api';
import { useSession } from '@/lib/session';

import { deadlineLabel, jobStatusLabel, priceLabel, workTone } from './vocabulary';

type Status = 'loading' | 'ready' | 'error';
type View = 'board' | 'posted' | 'bids';

export const JobBoard = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();
  const params = useSearchParams();

  const search = params.get('q') ?? '';
  const view: View =
    params.get('mine') === 'true' ? 'posted' : params.get('view') === 'bids' ? 'bids' : 'board';

  const [term, setTerm] = useState(search);
  const [jobs, setJobs] = useState<readonly JobSummaryResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (nextCursor?: string): Promise<void> => {
      if (sessionStatus !== 'authenticated') return;

      if (nextCursor === undefined) {
        setStatus('loading');
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const page = await createWorkApi(client).jobs({
          ...(search === '' ? {} : { q: search }),
          // The board is only jobs still taking bids; the two personal views must be able to
          // show a job that has been filled or cancelled, which is most of them.
          openOnly: view === 'board',
          mine: view === 'posted',
          ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
        });

        const items = view === 'bids' ? page.items.filter((job) => job.hasProposed) : page.items;

        setJobs((current) => {
          if (nextCursor === undefined) return items;
          const seen = new Set(current.map((job) => job.id));
          return [...current, ...items.filter((job) => !seen.has(job.id))];
        });
        setCursor(page.nextCursor);
        setStatus('ready');
      } catch (cause) {
        setError(describeError(cause));
        setStatus('error');
      } finally {
        setLoadingMore(false);
      }
    },
    [client, search, sessionStatus, view],
  );

  useEffect(() => {
    setTerm(search);
    void load();
  }, [load, search]);

  const tab = (key: View, label: string, href: string): React.JSX.Element => (
    <Link
      href={href}
      aria-current={view === key ? 'page' : undefined}
      className={cn(
        'flex h-9 items-center rounded-full px-sm text-small transition-colors',
        view === key ? 'bg-primary/10 font-medium text-primary' : 'text-muted hover:bg-raised',
      )}
    >
      {label}
    </Link>
  );

  const empty =
    view === 'posted'
      ? 'You have not posted a job yet. Describe the work, name a budget, and pick a freelancer from the proposals.'
      : view === 'bids'
        ? 'You have not bid on anything yet. A proposal needs a price at or below the budget and a little of your own words.'
        : search === ''
          ? 'No jobs are taking proposals right now. Post one, or come back in a day.'
          : `Nothing matches “${search}”.`;

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex flex-wrap items-center gap-sm">
        <nav className="flex items-center gap-xs" aria-label="Job views">
          {tab('board', 'Open work', '/work')}
          {tab('posted', 'Jobs I posted', '/work?mine=true')}
          {tab('bids', 'My proposals', '/work?view=bids')}
          {/* Contracts are a different resource with their own list, so this is a plain link
              rather than a fourth tab: a tab that navigates away from the board would lie
              about which page you are on. */}
          <Link
            href="/work/contracts"
            className="flex h-9 items-center rounded-full px-sm text-small text-muted transition-colors hover:bg-raised"
          >
            Contracts
          </Link>
        </nav>

        <Link href="/work/new" className={cn(buttonClass('primary', 'sm'), 'ml-auto')}>
          <Plus aria-hidden className="size-4" />
          Post a job
        </Link>
      </div>

      <form action="/work" method="get" role="search" className="flex items-center gap-xs">
        {view === 'posted' ? <input type="hidden" name="mine" value="true" /> : null}
        {view === 'bids' ? <input type="hidden" name="view" value="bids" /> : null}
        <div className="relative flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-sm top-1/2 size-4 -translate-y-1/2 text-muted"
          />
          <Input
            name="q"
            aria-label="Search jobs"
            placeholder="Search by title"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            className="pl-[36px]"
          />
        </div>
        <button type="submit" className={buttonClass('secondary', 'sm')}>
          Search
        </button>
      </form>

      {status === 'loading' ? (
        <div className="flex flex-col gap-sm" aria-busy>
          {[0, 1, 2].map((key) => (
            <div key={key} className="flex flex-col gap-xs rounded-lg border border-border p-md">
              <div className="skeleton h-5 w-48" />
              <div className="skeleton h-4 w-full" />
              <div className="skeleton h-4 w-32" />
            </div>
          ))}
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="flex flex-col gap-sm rounded-lg border border-border p-md">
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="self-start text-small font-medium text-primary underline"
          >
            Try again
          </button>
        </div>
      ) : null}

      {status === 'ready' && jobs.length === 0 ? (
        <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-lg">
          <Briefcase aria-hidden className="size-6 text-muted" />
          <p className="text-body text-muted">{empty}</p>
          <Link
            href={view === 'bids' ? '/work' : '/work/new'}
            className={buttonClass('primary', 'sm')}
          >
            {view === 'bids' ? 'Browse open work' : 'Post a job'}
          </Link>
        </div>
      ) : null}

      <ul className="flex flex-col gap-sm">
        {jobs.map((job) => (
          <li key={job.id}>
            <Link
              href={`/work/${job.id}`}
              className="flex flex-col gap-xs rounded-lg border border-border p-md transition-colors hover:border-primary/50 hover:bg-primary/5"
            >
              <span className="flex flex-wrap items-center gap-xs">
                <span className="text-body font-medium">{job.title}</span>
                <span
                  className={cn(
                    'ml-auto rounded-full px-[6px] py-[1px] text-caption',
                    workTone(job.status),
                  )}
                >
                  {jobStatusLabel[job.status]}
                </span>
              </span>

              <span className="flex flex-wrap items-center gap-xs text-caption text-muted">
                <span className="font-medium text-text">
                  {priceLabel(job.budgetMinor, job.currency)}
                </span>
                <span aria-hidden>·</span>
                <span>{deadlineLabel(job.deadline)}</span>
                <span aria-hidden>·</span>
                <span>
                  {job.proposalCount} {job.proposalCount === 1 ? 'proposal' : 'proposals'}
                </span>
                {job.hasProposed ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="text-primary">You applied</span>
                  </>
                ) : null}
                {job.isClient ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>Your job</span>
                  </>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {cursor === null ? null : (
        <button
          type="button"
          onClick={() => void load(cursor)}
          disabled={loadingMore}
          className={cn(buttonClass('secondary', 'sm'), 'self-center')}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
};
