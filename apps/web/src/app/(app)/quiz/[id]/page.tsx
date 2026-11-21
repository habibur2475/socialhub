/**
 * One quiz set.
 *
 * The set and the caller's latest attempt are fetched together: the attempt decides
 * whether the key is visible, whether the page opens in "resume" or "review", and
 * whether a fresh attempt is offered. Fetching them separately would let the page
 * render a Start button over an attempt that already exists.
 */

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';

import type { QuizSetResponse } from '@socialhub/contracts';

import { QuizRunner } from '@/components/quiz/quiz-runner';
import { describeError } from '@/lib/form';
import { createQuizApi } from '@/lib/quiz-api';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/time';

type Status = 'loading' | 'ready' | 'error';

export default function QuizSetPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const { client, status: sessionStatus } = useSession();

  const [set, setSet] = useState<QuizSetResponse | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setStatus('loading');
    setError(null);

    try {
      setSet(await createQuizApi(client).get(params.id));
      setStatus('ready');
    } catch (cause) {
      setError(describeError(cause));
      setStatus('error');
    }
  }, [client, params.id, sessionStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  if (status === 'loading') {
    return (
      <div className="mx-auto flex max-w-[720px] flex-col gap-sm" aria-busy>
        <div className="skeleton h-8 w-64" />
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-24 w-full" />
      </div>
    );
  }

  if (status === 'error' || set === null) {
    return (
      <div className="mx-auto flex max-w-[720px] flex-col gap-sm">
        <p role="alert" className="text-body text-danger">
          {error ?? 'That set is not available.'}
        </p>
        <Link href="/quiz" className="text-small font-medium text-primary underline">
          Back to the library
        </Link>
      </div>
    );
  }

  const now = new Date();

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <Link
          href="/quiz"
          className="inline-flex items-center gap-xs text-small text-muted hover:text-text"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Quiz
        </Link>

        <h1 className="text-heading">{set.title}</h1>
        {set.description === null ? null : (
          <p className="text-body text-muted">{set.description}</p>
        )}
        <p className="text-caption text-muted">
          by{' '}
          <Link href={`/u/${set.owner.username}`} className="hover:underline">
            {set.owner.displayName}
          </Link>{' '}
          · <span suppressHydrationWarning>{relativeTime(set.createdAt, now)}</span> ·{' '}
          {set.attemptCount} {set.attemptCount === 1 ? 'attempt' : 'attempts'}
        </p>
      </header>

      <QuizRunner set={set} initialAttempt={set.myAttempt} />
    </div>
  );
}
