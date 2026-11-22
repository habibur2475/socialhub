'use client';

/**
 * A timeline: composer, list, and "load more".
 *
 * `now` is captured once per render pass and passed down, rather than each card
 * calling `Date.now()`. Two cards rendered in the same list must not disagree
 * about the current time, and a shared value keeps the relative timestamps
 * consistent down the page.
 *
 * Pagination is keyset: the cursor is the last post id. "Load more" is a button
 * rather than an IntersectionObserver because a button is reachable by keyboard
 * and does not fire on a page the user is merely scrolling past.
 */

import { useCallback, useEffect, useState } from 'react';

import type { PostResponse } from '@socialhub/contracts';

import { describeError } from '@/lib/form';
import { createFeedApi } from '@/lib/feed-api';
import { useSession } from '@/lib/session';
import { PostCard } from './post-card';
import { PostComposer } from './post-composer';

export type TimelineProps = {
  /** Omitted for the home feed; set to render one author's posts. */
  readonly username?: string;
  readonly showComposer?: boolean;
  readonly emptyMessage?: string;
};

type Status = 'loading' | 'ready' | 'error';

export const Timeline = ({
  username,
  showComposer = true,
  emptyMessage = 'Nothing here yet. Posts from the people you follow will appear here.',
}: TimelineProps): React.JSX.Element => {
  const { client, session, status: sessionStatus } = useSession();

  const [posts, setPosts] = useState<readonly PostResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setStatus('loading');
    setError(null);

    try {
      const api = createFeedApi(client);
      const page = username === undefined ? await api.home() : await api.byAuthor(username);

      setPosts(page.items);
      setCursor(page.nextCursor);
      setStatus('ready');
    } catch (cause) {
      setError(describeError(cause));
      setStatus('error');
    }
  }, [client, sessionStatus, username]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async (): Promise<void> => {
    if (cursor === null) return;
    setLoadingMore(true);

    try {
      const api = createFeedApi(client);
      const page =
        username === undefined
          ? await api.home({ cursor })
          : await api.byAuthor(username, { cursor });

      // De-duplicate defensively: a post created between two requests can appear
      // on both pages, and React would warn about the repeated key.
      setPosts((current) => {
        const seen = new Set(current.map((post) => post.id));
        return [...current, ...page.items.filter((post) => !seen.has(post.id))];
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
          <div key={key} className="flex gap-sm border-b border-border p-md">
            <div className="skeleton size-11 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-xs">
              <div className="skeleton h-4 w-40" />
              <div className="skeleton h-4 w-full" />
              <div className="skeleton h-4 w-2/3" />
            </div>
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
          onClick={() => {
            void load();
          }}
          className="self-start text-small font-medium text-primary underline"
        >
          Try again
        </button>
      </div>
    );
  }

  const now = new Date();

  return (
    <div className="flex flex-col">
      {showComposer ? (
        <div className="pb-md">
          <PostComposer onPublished={() => void load()} />
        </div>
      ) : null}

      {posts.length === 0 ? (
        <p className="py-lg text-center text-small text-muted">{emptyMessage}</p>
      ) : (
        posts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            now={now}
            isOwn={post.author.accountId === session?.user.id}
            onChanged={() => {
              // A delete removes the card locally; anything else (a reply) means
              // the server state moved, so the page is re-read.
              void load();
            }}
          />
        ))
      )}

      {cursor === null ? null : (
        <button
          type="button"
          onClick={() => {
            void loadMore();
          }}
          disabled={loadingMore}
          className="mt-sm h-11 self-center rounded-md px-md text-small font-medium text-primary hover:underline disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}

      {error !== null && status === 'ready' ? (
        <p role="alert" className="pt-sm text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
};
