/**
 * A forum thread.
 *
 * The detail is fetched once and handed to `ThreadView` as its initial state: the view
 * then owns the local mutations (an added answer, an accepted answer, a deleted one) so
 * posting does not require a full reload of the thread.
 *
 * `nextCursor` is deliberately not paged here. A thread's first page is 50 answers,
 * which is past the point where a reader is scanning; the "load older" affordance
 * belongs with the pagination work that the feed already has, not in a second
 * implementation.
 */

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';

import type { ForumThreadDetailResponse } from '@socialhub/contracts';

import { ThreadView } from '@/components/forum/thread-view';
import { describeError } from '@/lib/form';
import { createForumApi } from '@/lib/forum-api';
import { useSession } from '@/lib/session';

type Status = 'loading' | 'ready' | 'error';

export default function ThreadPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const { client, status: sessionStatus } = useSession();

  const [detail, setDetail] = useState<ForumThreadDetailResponse | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setStatus('loading');
    setError(null);

    try {
      setDetail(await createForumApi(client).thread(params.id));
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
        <div className="skeleton h-8 w-72" />
        <div className="skeleton h-32 w-full" />
      </div>
    );
  }

  if (status === 'error' || detail === null) {
    return (
      <div className="mx-auto flex max-w-[720px] flex-col gap-sm">
        <p role="alert" className="text-body text-danger">
          {error ?? 'That thread is not available.'}
        </p>
        <Link href="/forum" className="text-small font-medium text-primary underline">
          Back to the forum
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-lg">
      <Link
        href="/forum"
        className="inline-flex items-center gap-xs text-small text-muted hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Forum
      </Link>

      <ThreadView threadId={detail.thread.id} initial={detail} />
    </div>
  );
}
