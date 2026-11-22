'use client';

/**
 * The archive.
 *
 * Three tabs, one component: the public blog, one tag, and the author's own workspace.
 * They are the same list with one predicate, which is why the filter is a URL parameter
 * rather than local state — a filtered view can be linked to and survives a reload.
 *
 * The row shows the excerpt and the reading time, never the body: a list of 20 articles
 * that downloaded 20 bodies would be a page nobody waits for. The status chip appears only
 * under "Mine", because a reader never sees a draft at all.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Clock, FileText, Plus, Tag } from 'lucide-react';

import type { ArticleSummaryResponse } from '@socialhub/contracts';

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

export const ArticleList = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();
  const params = useSearchParams();
  const router = useRouter();

  const tag = params.get('tag');
  const mine = params.get('mine') === 'true';

  const [articles, setArticles] = useState<readonly ArticleSummaryResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setStatus('loading');
    setError(null);

    try {
      const page = await createBlogApi(client).articles({
        ...(tag === null ? {} : { tag }),
        ...(mine ? { mine: true } : {}),
      });
      setArticles(page.items);
      setCursor(page.nextCursor);
      setStatus('ready');
    } catch (cause) {
      setError(describeError(cause));
      setStatus('error');
    }
  }, [client, mine, sessionStatus, tag]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async (): Promise<void> => {
    if (cursor === null) return;
    setLoadingMore(true);

    try {
      const page = await createBlogApi(client).articles({
        cursor,
        ...(tag === null ? {} : { tag }),
        ...(mine ? { mine: true } : {}),
      });
      setArticles((current) => {
        const seen = new Set(current.map((article) => article.id));
        return [...current, ...page.items.filter((article) => !seen.has(article.id))];
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
          onClick={() => router.push('/blog')}
          aria-current={tag === null && !mine ? 'true' : undefined}
          className={cn(
            'h-9 rounded-full px-sm text-small transition-colors',
            tag === null && !mine
              ? 'bg-primary/10 font-medium text-primary'
              : 'text-muted hover:bg-raised',
          )}
        >
          All articles
        </button>
        <button
          type="button"
          onClick={() => router.push('/blog?mine=true')}
          aria-current={mine ? 'true' : undefined}
          className={cn(
            'h-9 rounded-full px-sm text-small transition-colors',
            mine ? 'bg-primary/10 font-medium text-primary' : 'text-muted hover:bg-raised',
          )}
        >
          Mine
        </button>
        <Link href="/blog/new" className={cn(buttonClass('primary', 'sm'), 'ml-auto')}>
          <Plus aria-hidden className="size-4" />
          Write
        </Link>
      </div>

      {tag !== null ? (
        <p className="flex items-center gap-xs text-small text-muted">
          <Tag aria-hidden className="size-3" />
          Tagged <span className="font-medium text-text">{tag}</span>
        </p>
      ) : null}

      {status === 'loading' ? (
        <div className="flex flex-col gap-sm" aria-busy>
          {[0, 1, 2].map((key) => (
            <div key={key} className="flex flex-col gap-xs rounded-lg border border-border p-md">
              <div className="skeleton h-5 w-64" />
              <div className="skeleton h-4 w-full" />
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

      {status === 'ready' && articles.length === 0 ? (
        <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-lg">
          <FileText aria-hidden className="size-6 text-muted" />
          <p className="text-body text-muted">
            {mine
              ? 'Nothing here yet. A draft is private until you publish it.'
              : tag !== null
                ? 'No articles carry that tag yet.'
                : 'The blog is empty. Write the first article and it becomes the front page.'}
          </p>
          <Link href="/blog/new" className={buttonClass('primary', 'sm')}>
            Write an article
          </Link>
        </div>
      ) : null}

      <ul className="flex flex-col gap-md">
        {articles.map((article) => (
          <li key={article.id} className="border-b border-border pb-md">
            <Link href={`/blog/${article.slug}`} className="flex flex-col gap-xs">
              <span className="flex items-center gap-xs">
                <span className="text-body font-semibold">{article.title}</span>
                {mine ? (
                  <span
                    className={cn(
                      'rounded-full px-[6px] py-[1px] text-caption',
                      article.status === 'PUBLISHED'
                        ? 'bg-primary/10 text-primary'
                        : 'bg-raised text-muted',
                    )}
                  >
                    {STATUS_LABEL[article.status] ?? article.status}
                  </span>
                ) : null}
              </span>

              <span className="text-body text-muted">{article.excerpt}</span>

              <span className="flex flex-wrap items-center gap-xs text-caption text-muted">
                <span>{article.author.displayName}</span>
                <span aria-hidden>·</span>
                <span className="flex items-center gap-[2px]">
                  <Clock aria-hidden className="size-3" />
                  {article.readingMinutes} min read
                </span>
                {article.status === 'SCHEDULED' && article.scheduledFor !== null ? (
                  <>
                    <span aria-hidden>·</span>
                    <span suppressHydrationWarning>
                      goes live {relativeTime(article.scheduledFor, now)}
                    </span>
                  </>
                ) : article.publishedAt !== null ? (
                  <>
                    <span aria-hidden>·</span>
                    <span suppressHydrationWarning>{relativeTime(article.publishedAt, now)}</span>
                  </>
                ) : null}
                {article.tags.length > 0 ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="flex flex-wrap gap-xs">
                      {article.tags.map((articleTag) => (
                        <Link
                          key={articleTag}
                          href={`/blog?tag=${encodeURIComponent(articleTag)}`}
                          className="text-primary hover:underline"
                        >
                          #{articleTag}
                        </Link>
                      ))}
                    </span>
                  </>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {cursor !== null ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className={cn(buttonClass('secondary', 'sm'), 'self-center')}
        >
          {loadingMore ? 'Loading…' : 'Load older articles'}
        </button>
      ) : null}
    </div>
  );
};
