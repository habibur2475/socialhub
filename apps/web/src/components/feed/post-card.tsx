'use client';

/**
 * One post in a timeline.
 *
 * The like button is optimistic: pressing it flips immediately and reconciles with
 * the server's count, so the interaction does not wait on a round trip. A failure
 * rolls the state back rather than leaving a heart lit for a like that never
 * landed.
 *
 * Deletion is confirmable rather than instant, because it is irreversible and an
 * accidental tap on a phone is easy.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Heart, MessageSquare, MoreHorizontal, Repeat2, Trash2 } from 'lucide-react';
import type { PostResponse } from '@socialhub/contracts';

import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createFeedApi } from '@/lib/feed-api';
import { useSession } from '@/lib/session';
import { absoluteTime, relativeTime } from '@/lib/time';
import { PostComposer } from './post-composer';

export type PostCardProps = {
  readonly post: PostResponse;
  readonly now: Date;
  readonly onChanged: () => void;
  /** Only the author sees the actions menu; everyone else gets no affordance. */
  readonly isOwn: boolean;
};

const VISIBILITY_HINT: Record<PostResponse['visibility'], string> = {
  PUBLIC: 'Everyone',
  FOLLOWERS: 'Followers',
  PRIVATE: 'Only me',
};

export const PostCard = ({ post, now, onChanged, isOwn }: PostCardProps): React.JSX.Element => {
  const { client } = useSession();

  const [liked, setLiked] = useState(post.likedByMe);
  const [likeCount, setLikeCount] = useState(post.likeCount);
  const [replying, setReplying] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleLike = async (): Promise<void> => {
    // Optimistic, with a captured previous state so a failure can roll back to
    // exactly where it was rather than to a guess.
    const previous = { liked, likeCount };
    setLiked(!liked);
    setLikeCount(liked ? Math.max(likeCount - 1, 0) : likeCount + 1);
    setError(null);

    try {
      const api = createFeedApi(client);
      const result = liked ? await api.unlike(post.id) : await api.like(post.id);
      setLiked(result.liked);
      setLikeCount(result.likeCount);
    } catch (cause) {
      setLiked(previous.liked);
      setLikeCount(previous.likeCount);
      setError(describeError(cause));
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setMenuOpen(false);
    try {
      await createFeedApi(client).remove(post.id);
      onChanged();
    } catch (cause) {
      setError(describeError(cause));
      setBusy(false);
    }
  };

  const initials = post.author.displayName.trim().slice(0, 1).toUpperCase() || '?';

  return (
    <article
      className={cn(
        'flex gap-sm border-b border-border p-md transition-opacity',
        busy && 'opacity-50',
      )}
      aria-busy={busy}
    >
      <Link
        href={`/u/${post.author.username}`}
        aria-label={`${post.author.displayName}'s profile`}
        className="grid size-11 shrink-0 place-items-center rounded-full bg-primary/10 text-small font-semibold text-primary"
      >
        <span aria-hidden>{initials}</span>
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-xs">
        <div className="flex flex-wrap items-baseline gap-xs">
          <Link
            href={`/u/${post.author.username}`}
            className="truncate text-small font-semibold text-text hover:underline"
          >
            {post.author.displayName}
          </Link>
          <span className="truncate text-caption text-text-muted">@{post.author.username}</span>
          <span aria-hidden className="text-caption text-text-muted">
            ·
          </span>
          <time
            dateTime={post.createdAt}
            title={absoluteTime(post.createdAt)}
            className="text-caption text-text-muted"
          >
            {relativeTime(post.createdAt, now)}
          </time>
          {post.visibility === 'PUBLIC' ? null : (
            <span className="rounded-sm bg-surface-raised px-xs text-caption text-text-muted">
              {VISIBILITY_HINT[post.visibility]}
            </span>
          )}
          {post.editedAt === null ? null : (
            <span className="text-caption text-text-muted">edited</span>
          )}

          <div className={cn('relative', isOwn ? 'ml-auto' : 'ml-auto w-0')}>
            {isOwn ? (
              <button
                type="button"
                aria-label="Post actions"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
                className="inline-flex size-11 items-center justify-center rounded-md text-text-muted hover:bg-surface-raised"
              >
                <MoreHorizontal aria-hidden className="size-4" />
              </button>
            ) : null}
            {menuOpen ? (
              <div className="absolute right-0 top-[calc(100%+4px)] z-popover w-44 rounded-md border border-border bg-raised p-xs shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    void remove();
                  }}
                  className="flex h-11 w-full items-center gap-sm rounded-sm px-sm text-small text-danger hover:bg-surface"
                >
                  <Trash2 aria-hidden className="size-4" /> Delete post
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {/* `whitespace-pre-line` keeps intentional line breaks; the body is plain
            text, so there is no markup to render and no HTML to sanitise. */}
        <p className="whitespace-pre-line break-words text-body text-text">{post.body}</p>

        {error === null ? null : (
          <p role="alert" className="text-caption text-danger">
            {error}
          </p>
        )}

        <div className="flex items-center gap-md pt-xs">
          <button
            type="button"
            onClick={() => setReplying((open) => !open)}
            aria-expanded={replying}
            className="inline-flex h-11 items-center gap-xs rounded-md px-xs text-caption text-text-muted hover:text-text"
          >
            <MessageSquare aria-hidden className="size-4" />
            <span className="tabular-nums">{post.replyCount}</span>
            <span className="sr-only">replies</span>
          </button>

          <span className="inline-flex h-11 items-center gap-xs px-xs text-caption text-text-muted">
            <Repeat2 aria-hidden className="size-4" />
            <span className="tabular-nums">{post.repostCount}</span>
            <span className="sr-only">reposts</span>
          </span>

          <button
            type="button"
            onClick={() => {
              void toggleLike();
            }}
            aria-pressed={liked}
            className={cn(
              'inline-flex h-11 items-center gap-xs rounded-md px-xs text-caption',
              liked ? 'text-danger' : 'text-text-muted hover:text-text',
            )}
          >
            <Heart aria-hidden className={cn('size-4', liked && 'fill-current')} />
            <span className="tabular-nums">{likeCount}</span>
            <span className="sr-only">likes</span>
          </button>
        </div>

        {replying ? (
          <PostComposer
            replyTo={post.id}
            placeholder={`Reply to @${post.author.username}`}
            autoFocus
            onPublished={() => {
              setReplying(false);
              onChanged();
            }}
          />
        ) : null}
      </div>
    </article>
  );
};
