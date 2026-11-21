'use client';

/**
 * The quiz library.
 *
 * A list of sets with the two facts a reader needs to choose one: how many questions
 * and how many attempts it has had. Attempt counts are shown because a set nobody has
 * tried is probably broken; hiding that number hides the signal.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { GraduationCap, Timer } from 'lucide-react';

import type { QuizSetSummaryResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { describeError } from '@/lib/form';
import { createQuizApi } from '@/lib/quiz-api';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/time';

type Status = 'loading' | 'ready' | 'error';

const VISIBILITY_LABEL: Record<QuizSetSummaryResponse['visibility'], string> = {
  PUBLIC: 'Public',
  FOLLOWERS: 'Followers',
  PRIVATE: 'Only me',
};

export const QuizList = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();

  const [sets, setSets] = useState<readonly QuizSetSummaryResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setStatus('loading');
    setError(null);

    try {
      const page = await createQuizApi(client).list();
      setSets(page.items);
      setCursor(page.nextCursor);
      setStatus('ready');
    } catch (cause) {
      setError(describeError(cause));
      setStatus('error');
    }
  }, [client, sessionStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async (): Promise<void> => {
    if (cursor === null) return;
    setLoadingMore(true);

    try {
      const page = await createQuizApi(client).list({ cursor });
      setSets((current) => {
        const seen = new Set(current.map((set) => set.id));
        return [...current, ...page.items.filter((set) => !seen.has(set.id))];
      });
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  if (status === 'loading') {
    return (
      <div className="flex flex-col gap-sm" aria-busy>
        {[0, 1, 2].map((key) => (
          <div key={key} className="flex flex-col gap-xs rounded-lg border border-border p-md">
            <div className="skeleton h-5 w-52" />
            <div className="skeleton h-4 w-32" />
          </div>
        ))}
      </div>
    );
  }

  if (status === 'error') {
    return (
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
    );
  }

  if (sets.length === 0) {
    return (
      <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-lg">
        <GraduationCap aria-hidden className="size-6 text-muted" />
        <p className="text-body text-muted">
          No quiz sets yet. Create one and it appears here for everyone it is addressed to.
        </p>
        <Link href="/quiz/new" className={buttonClass('primary', 'sm')}>
          Create a set
        </Link>
      </div>
    );
  }

  const now = new Date();

  return (
    <div className="flex flex-col gap-sm">
      {sets.map((set) => (
        <article key={set.id} className="rounded-lg border border-border bg-surface p-md">
          <div className="flex flex-wrap items-baseline gap-xs">
            <h2 className="text-subheading">
              <Link href={`/quiz/${set.id}`} className="hover:underline">
                {set.title}
              </Link>
            </h2>
            <span className="rounded-sm bg-raised px-1 text-caption text-muted">
              {VISIBILITY_LABEL[set.visibility]}
            </span>
            {set.timeLimitSeconds === null ? null : (
              <span className="inline-flex items-center gap-[2px] text-caption text-muted">
                <Timer aria-hidden className="size-3" />
                {Math.round(set.timeLimitSeconds / 60)} min
              </span>
            )}
          </div>

          {set.description === null ? null : (
            <p className="mt-xs line-clamp-2 text-small text-muted">{set.description}</p>
          )}

          <p className="mt-xs text-caption text-muted">
            {set.questionCount} {set.questionCount === 1 ? 'question' : 'questions'} ·{' '}
            {set.attemptCount} {set.attemptCount === 1 ? 'attempt' : 'attempts'} · by{' '}
            <Link href={`/u/${set.owner.username}`} className="hover:underline">
              {set.owner.displayName}
            </Link>{' '}
            <span suppressHydrationWarning>{relativeTime(set.createdAt, now)}</span>
          </p>
        </article>
      ))}

      {cursor === null ? null : (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className={buttonClass('secondary', 'sm', 'self-center')}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
};
