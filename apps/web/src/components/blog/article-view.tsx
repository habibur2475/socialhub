'use client';

/**
 * The article page.
 *
 * Reading and editing live on one route because they are the same article: the author sees
 * their own draft with the publish controls attached, and a reader sees prose and nothing
 * else. The controls are rendered from `isAuthor`, which the server sets — the client never
 * decides who may publish.
 *
 * Scheduling asks for a local date and time and converts to an ISO instant once, here, so
 * the server never has to parse a timezone.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Clock, Globe, Lock, Trash2 } from 'lucide-react';

import type { ArticleResponse } from '@socialhub/contracts';

import { ArticleBody } from '@/components/blog/article-body';
import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createBlogApi } from '@/lib/blog-api';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/time';

type Status = 'loading' | 'ready' | 'error';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

export const ArticleView = ({ idOrSlug }: { readonly idOrSlug: string }): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();
  const router = useRouter();

  const [article, setArticle] = useState<ArticleResponse | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setStatus('loading');
    setError(null);

    try {
      setArticle(await createBlogApi(client).article(idOrSlug));
      setStatus('ready');
    } catch (cause) {
      setError(describeError(cause));
      setStatus('error');
    }
  }, [client, idOrSlug, sessionStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (run: () => Promise<ArticleResponse>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setActionError(null);

    try {
      setArticle(await run());
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (busy || article === null) return;
    setBusy(true);
    setActionError(null);

    try {
      await createBlogApi(client).remove(article.id);
      router.push('/blog?mine=true');
    } catch (cause) {
      setActionError(describeError(cause));
      setBusy(false);
    }
  };

  if (status === 'loading') {
    return (
      <div className="flex flex-col gap-sm" aria-busy>
        <div className="skeleton h-8 w-2/3" />
        <div className="skeleton h-4 w-40" />
        <div className="skeleton h-40 w-full" />
      </div>
    );
  }

  if (status === 'error' || article === null) {
    return (
      <div className="flex flex-col gap-sm rounded-lg border border-border p-md">
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
        <p className="text-small text-muted">
          A draft is its author’s alone, and a block hides an article in both directions — so an
          article you cannot read answers exactly like one that is not there.
        </p>
        <Link href="/blog" className="text-small font-medium text-primary underline">
          Back to the blog
        </Link>
      </div>
    );
  }

  const now = new Date();
  const api = createBlogApi(client);

  return (
    <article className="flex flex-col gap-md">
      <header className="flex flex-col gap-sm">
        <div className="flex items-center gap-sm">
          <Link
            href="/blog"
            aria-label="Back to the blog"
            className="rounded-full p-xs text-muted transition-colors hover:bg-raised"
          >
            <ArrowLeft aria-hidden className="size-4" />
          </Link>
          {article.isAuthor ? (
            <span
              className={cn(
                'flex items-center gap-xs rounded-full px-sm py-[2px] text-caption',
                article.status === 'PUBLISHED'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-raised text-muted',
              )}
            >
              {article.status === 'PUBLISHED' ? (
                <Globe aria-hidden className="size-3" />
              ) : (
                <Lock aria-hidden className="size-3" />
              )}
              {STATUS_LABEL[article.status] ?? article.status}
            </span>
          ) : null}
        </div>

        <h1 className="text-h1 font-semibold leading-tight">{article.title}</h1>

        <p className="flex flex-wrap items-center gap-xs text-small text-muted">
          <Link href={`/u/${article.author.username}`} className="hover:underline">
            {article.author.displayName}
          </Link>
          <span aria-hidden>·</span>
          <span className="flex items-center gap-[2px]">
            <Clock aria-hidden className="size-3" />
            {article.readingMinutes} min read
          </span>
          {article.publishedAt !== null ? (
            <>
              <span aria-hidden>·</span>
              <span suppressHydrationWarning>{relativeTime(article.publishedAt, now)}</span>
            </>
          ) : null}
          {article.scheduledFor !== null ? (
            <>
              <span aria-hidden>·</span>
              <span suppressHydrationWarning>
                scheduled {relativeTime(article.scheduledFor, now)}
              </span>
            </>
          ) : null}
        </p>

        {article.tags.length > 0 ? (
          <p className="flex flex-wrap gap-xs">
            {article.tags.map((tag) => (
              <Link
                key={tag}
                href={`/blog?tag=${encodeURIComponent(tag)}`}
                className="rounded-full bg-raised px-sm py-[2px] text-caption text-muted transition-colors hover:text-foreground"
              >
                #{tag}
              </Link>
            ))}
          </p>
        ) : null}
      </header>

      <ArticleBody body={article.body} />

      {article.isAuthor ? (
        <section className="mt-md flex flex-col gap-sm rounded-lg border border-border p-md">
          <h2 className="text-body font-medium">Publishing</h2>

          <div className="flex flex-wrap items-center gap-xs">
            {article.status !== 'PUBLISHED' && article.status !== 'ARCHIVED' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => api.publish(article.id, { status: 'PUBLISHED' }))}
                className={buttonClass('primary', 'sm')}
              >
                Publish now
              </button>
            ) : null}

            {article.status === 'PUBLISHED' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => api.publish(article.id, { status: 'DRAFT' }))}
                className={buttonClass('secondary', 'sm')}
              >
                Unpublish
              </button>
            ) : null}

            {article.status !== 'ARCHIVED' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(() => api.publish(article.id, { status: 'ARCHIVED' }))}
                className={buttonClass('secondary', 'sm')}
              >
                Archive
              </button>
            ) : null}

            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className={buttonClass('danger', 'sm')}
            >
              <Trash2 aria-hidden className="size-4" />
              Delete
            </button>
          </div>

          {article.status !== 'ARCHIVED' ? (
            <form
              className="flex flex-wrap items-end gap-sm"
              onSubmit={(event) => {
                event.preventDefault();
                if (scheduleAt === '') return;
                // `datetime-local` is a local wall-clock value; one conversion here keeps
                // the server free of timezone parsing.
                const iso = new Date(scheduleAt).toISOString();
                void act(() => api.publish(article.id, { status: 'SCHEDULED', scheduledFor: iso }));
              }}
            >
              <div className="flex flex-col gap-xs">
                <label htmlFor="schedule-at" className="text-small font-medium">
                  Schedule for
                </label>
                <input
                  id="schedule-at"
                  type="datetime-local"
                  value={scheduleAt}
                  onChange={(event) => setScheduleAt(event.target.value)}
                  className="h-11 rounded-lg border border-border bg-surface px-sm text-body outline-none focus:border-primary"
                />
              </div>
              <button
                type="submit"
                disabled={busy || scheduleAt === ''}
                className={buttonClass('secondary', 'sm')}
              >
                Schedule
              </button>
            </form>
          ) : (
            <p className="text-small text-muted">
              An archived article keeps its URL and its date, but it is not in the archive and it
              cannot be brought back — that is what makes archiving different from unpublishing.
            </p>
          )}

          {actionError !== null ? (
            <p role="alert" className="text-small text-danger">
              {actionError}
            </p>
          ) : null}
        </section>
      ) : null}
    </article>
  );
};
