'use client';

/**
 * The forum index.
 *
 * Categories and threads are fetched together because they answer one question: "where
 * do I read next?" A category filter is a URL parameter rather than local state, so a
 * filtered view can be linked to and survives a reload.
 *
 * Pinned threads sort first because that is what a pin means; the server orders them,
 * so the client does not re-sort a list it did not fully load.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, Lock, MessagesSquare, Pin, Plus } from 'lucide-react';

import type { ForumCategoryResponse, ForumThreadSummaryResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createForumApi } from '@/lib/forum-api';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/time';

type Status = 'loading' | 'ready' | 'error';

export const ForumList = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();
  const params = useSearchParams();
  const router = useRouter();

  const category = params.get('category');

  const [categories, setCategories] = useState<readonly ForumCategoryResponse[]>([]);
  const [threads, setThreads] = useState<readonly ForumThreadSummaryResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setStatus('loading');
    setError(null);

    try {
      const api = createForumApi(client);
      const [categoryPage, threadPage] = await Promise.all([
        api.categories(),
        api.threads(category === null ? {} : { category }),
      ]);

      setCategories(categoryPage.items);
      setThreads(threadPage.items);
      setCursor(threadPage.nextCursor);
      setStatus('ready');
    } catch (cause) {
      setError(describeError(cause));
      setStatus('error');
    }
  }, [category, client, sessionStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async (): Promise<void> => {
    if (cursor === null) return;
    setLoadingMore(true);

    try {
      const page = await createForumApi(client).threads(
        category === null ? { cursor } : { cursor, category },
      );
      setThreads((current) => {
        const seen = new Set(current.map((thread) => thread.id));
        return [...current, ...page.items.filter((thread) => !seen.has(thread.id))];
      });
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  const now = new Date();

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex flex-wrap items-center gap-xs">
        <button
          type="button"
          onClick={() => router.push('/forum')}
          aria-current={category === null ? 'true' : undefined}
          className={cn(
            'h-9 rounded-full px-sm text-small transition-colors',
            category === null
              ? 'bg-primary/10 font-medium text-primary'
              : 'text-muted hover:bg-raised',
          )}
        >
          All
        </button>

        {categories.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => router.push(`/forum?category=${encodeURIComponent(entry.path)}`)}
            aria-current={category === entry.path ? 'true' : undefined}
            className={cn(
              'h-9 rounded-full px-sm text-small transition-colors',
              category === entry.path
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-muted hover:bg-raised',
            )}
          >
            {entry.name}
            <span className="ml-xs text-caption text-muted">{entry.threadCount}</span>
          </button>
        ))}
      </div>

      {status === 'loading' ? (
        <div className="flex flex-col gap-sm" aria-busy>
          {[0, 1, 2].map((key) => (
            <div key={key} className="flex flex-col gap-xs rounded-lg border border-border p-md">
              <div className="skeleton h-5 w-64" />
              <div className="skeleton h-4 w-40" />
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

      {status === 'ready' && threads.length === 0 ? (
        <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-lg">
          <MessagesSquare aria-hidden className="size-6 text-muted" />
          <p className="text-body text-muted">
            No threads here yet. Ask the first question and the answer becomes useful to the next
            person too.
          </p>
          <Link href="/forum/new" className={buttonClass('primary', 'sm')}>
            <Plus aria-hidden className="size-4" />
            Start a thread
          </Link>
        </div>
      ) : null}

      {threads.length > 0 ? (
        <ul className="flex flex-col">
          {threads.map((thread) => (
            <li key={thread.id} className="border-b border-border">
              <Link
                href={`/forum/threads/${thread.id}`}
                className="flex flex-col gap-[2px] p-md transition-colors duration-fast hover:bg-raised"
              >
                <span className="flex items-center gap-xs text-body font-medium">
                  {thread.pinned ? (
                    <Pin aria-label="Pinned" className="size-3 shrink-0 text-primary" />
                  ) : null}
                  {thread.locked ? (
                    <Lock aria-label="Locked" className="size-3 shrink-0 text-muted" />
                  ) : null}
                  {thread.title}
                  {thread.hasAcceptedAnswer ? (
                    <CircleCheck aria-label="Answered" className="size-4 shrink-0 text-success" />
                  ) : null}
                </span>

                <span className="text-caption text-muted">
                  {thread.categoryPath} · {thread.author.displayName} · {thread.answerCount}{' '}
                  {thread.answerCount === 1 ? 'answer' : 'answers'} ·{' '}
                  <span suppressHydrationWarning>{relativeTime(thread.lastActivityAt, now)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

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
