/**
 * One post, with its replies.
 *
 * The page exists because a notification has to point somewhere: "Ada liked your post"
 * that lands on the whole timeline is a dead end, and the reader then has to find the
 * post themselves. The composer is shown so a reply can be written from here.
 *
 * Ownership is decided by comparing the post's author with the signed-in account id
 * from the session; the API enforces it again, so a forged client change deletes
 * nothing.
 */

'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';

import type { PostResponse, TimelineResponse } from '@socialhub/contracts';

import { PostCard } from '@/components/feed/post-card';
import { PostComposer } from '@/components/feed/post-composer';
import { describeError } from '@/lib/form';
import { createFeedApi } from '@/lib/feed-api';
import { useSession } from '@/lib/session';

type Status = 'loading' | 'ready' | 'error';

export default function PostPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const { client, session, status: sessionStatus } = useSession();

  const [post, setPost] = useState<PostResponse | null>(null);
  const [replies, setReplies] = useState<readonly PostResponse[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setStatus('loading');
    setError(null);

    try {
      const api = createFeedApi(client);
      const current = await api.get(params.id);
      setPost(current);

      // Replies come from the author's timeline filtered by `replyTo`, which is the
      // only read exposed today. A dedicated replies endpoint belongs with threading,
      // not with this page.
      const page: TimelineResponse = await api.byAuthor(current.author.username, { limit: 50 });
      setReplies(page.items.filter((item) => item.replyTo === current.id));

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
      <div className="mx-auto flex max-w-[640px] flex-col gap-sm" aria-busy>
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-24 w-full" />
      </div>
    );
  }

  if (status === 'error' || post === null) {
    return (
      <div className="mx-auto flex max-w-[640px] flex-col gap-sm">
        <p role="alert" className="text-body text-danger">
          {error ?? 'That post is not available.'}
        </p>
        <Link href="/" className="text-small font-medium text-primary underline">
          Back to the timeline
        </Link>
      </div>
    );
  }

  const now = new Date();
  const ownId = session?.user.id;

  return (
    <div className="mx-auto flex max-w-[640px] flex-col gap-md">
      <Link
        href="/"
        className="inline-flex items-center gap-xs text-small text-muted hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Timeline
      </Link>

      <article>
        <PostCard
          post={post}
          now={now}
          onChanged={() => void load()}
          isOwn={post.author.accountId === ownId}
        />
      </article>

      <PostComposer
        replyTo={post.id}
        placeholder="Write a reply…"
        onPublished={() => void load()}
      />

      <section aria-label="Replies" className="flex flex-col">
        {replies.length === 0 ? (
          <p className="rounded-lg border border-border p-md text-body text-muted">
            No replies yet.
          </p>
        ) : (
          replies.map((reply) => (
            <PostCard
              key={reply.id}
              post={reply}
              now={now}
              onChanged={() => void load()}
              isOwn={reply.author.accountId === ownId}
            />
          ))
        )}
      </section>
    </div>
  );
}
