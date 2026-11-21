/**
 * Feed use cases.
 *
 * The visibility authority is the database (`can_view_post`), not this service.
 * That is a deliberate inversion of the profile module, where redaction happens
 * in code: a timeline is a set-valued query, and re-checking every row in
 * TypeScript would mean loading rows the viewer may not see, then trusting a
 * second implementation of the same rule to remove them. One rule, in one place,
 * applied by the query that returns the rows.
 *
 * This service therefore does three things: validate a write against the domain
 * rules, decide the audience snapshot, and shape the response.
 */

import { Injectable } from '@nestjs/common';
import {
  type PostAudience,
  prepareBody,
  requiresAudienceRows,
  effectiveReplyVisibility,
} from '@socialhub/kernel';

import { DomainException } from '../../../common/filters/domain-exception.js';
import { appError } from '@socialhub/kernel';
import type { IdGenerator } from '../../auth/application/ports.js';
import type { FeedEvents, PostRecord, PostStore } from './ports.js';

export type CreatePostInput = {
  readonly body: string;
  readonly visibility: PostAudience;
  readonly replyTo?: string | undefined;
};

export type PostView = {
  readonly id: string;
  readonly author: PostRecord['author'];
  readonly body: string;
  readonly visibility: PostAudience;
  readonly likeCount: number;
  readonly replyCount: number;
  readonly repostCount: number;
  readonly likedByMe: boolean;
  readonly replyTo: string | null;
  readonly repostOf: null;
  readonly editedAt: string | null;
  readonly createdAt: string;
};

export type TimelineView = {
  readonly items: readonly PostView[];
  readonly nextCursor: string | null;
};

@Injectable()
export class FeedService {
  public constructor(
    private readonly posts: PostStore,
    private readonly ids: IdGenerator,
    /**
     * Notifications are emitted as events, after the write has committed. The feed
     * states what happened; the notification module decides who is told.
     */
    private readonly events: FeedEvents,
  ) {}

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  public async createPost(authorId: string, input: CreatePostInput): Promise<PostView> {
    const prepared = prepareBody(input.body);
    if (!prepared.allowed) {
      throw new DomainException(
        appError(
          'VALIDATION_FAILED',
          prepared.reason === 'EMPTY' ? 'Write something first' : 'That post is too long',
        ),
      );
    }

    let visibility = input.visibility;
    const replyTo = input.replyTo ?? null;

    if (replyTo !== null) {
      const parent = await this.posts.find(replyTo, authorId);
      // Replying to something you cannot see is not permitted, and the answer is
      // NOT_FOUND rather than FORBIDDEN: the same reasoning as the profile block
      // rule — a distinguishable denial reveals the post exists.
      if (parent === null || !(await this.posts.canView(replyTo, authorId))) {
        throw new DomainException(appError('NOT_FOUND', 'That post is not available'));
      }
      // A reply is never wider than its parent.
      visibility = effectiveReplyVisibility(visibility, parent.visibility);
    }

    // The audience is captured *now*, in the same transaction as the post. A
    // follower gained later was not part of the audience the author addressed.
    const audienceAccountIds = requiresAudienceRows(visibility)
      ? await this.posts.acceptedFollowerIds(authorId)
      : [];

    const created = await this.posts.create({
      id: this.ids.next(),
      authorId,
      body: prepared.body,
      visibility,
      replyTo,
      audienceAccountIds,
    });

    if (created === null) {
      throw new DomainException(appError('INTERNAL_ERROR', 'The post could not be created'));
    }

    // Emitted after the write, never before: a notification for a post that failed
    // to save is a dead link. A reply also notifies its parent's author; a fresh
    // post only notifies mentions, which the adapter extracts from the body.
    if (replyTo !== null && created.replyTo !== null) {
      const parent = await this.posts.find(created.replyTo, authorId);
      if (parent !== null) {
        await this.events.emit({
          type: 'POST_REPLIED',
          actorId: authorId,
          postId: created.id,
          parentAuthorId: parent.authorId,
          body: created.body,
        });
      }
    } else {
      await this.events.emit({
        type: 'POST_PUBLISHED',
        actorId: authorId,
        postId: created.id,
        body: created.body,
      });
    }

    return toView(created);
  }

  public async editPost(authorId: string, postId: string, body: string): Promise<PostView> {
    const prepared = prepareBody(body);
    if (!prepared.allowed) {
      throw new DomainException(
        appError(
          'VALIDATION_FAILED',
          prepared.reason === 'EMPTY' ? 'Write something first' : 'That post is too long',
        ),
      );
    }

    const updated = await this.posts.updateBody(postId, authorId, prepared.body);
    // A post the caller does not own is indistinguishable from one that does not
    // exist, so ownership never leaks through an error code.
    if (updated === null) throw new DomainException(appError('NOT_FOUND', 'Post not found'));

    return toView(updated);
  }

  public async deletePost(authorId: string, postId: string): Promise<void> {
    const removed = await this.posts.remove(postId, authorId);
    if (!removed) throw new DomainException(appError('NOT_FOUND', 'Post not found'));
  }

  /**
   * Likes are idempotent per direction: liking twice is one like, unliking a post
   * you never liked is a no-op. The response states the resulting state rather
   * than an acknowledgment, so a client that lost a race can reconcile without a
   * second read.
   */
  public async setLike(
    accountId: string,
    postId: string,
    liked: boolean,
  ): Promise<{ liked: boolean; likeCount: number }> {
    const visible = await this.posts.canView(postId, accountId);
    if (!visible) throw new DomainException(appError('NOT_FOUND', 'Post not found'));

    await this.posts.setLike(postId, accountId, liked);

    const post = await this.posts.find(postId, accountId);
    if (post === null) throw new DomainException(appError('NOT_FOUND', 'Post not found'));

    // Only a *new* like is news. Un-liking must not notify the author, and without
    // this guard the toggle would produce a notification on every other click.
    if (liked) {
      await this.events.emit({
        type: 'POST_LIKED',
        actorId: accountId,
        postId,
        authorId: post.authorId,
        preview: post.body,
      });
    }

    return { liked: post.likedByMe, likeCount: post.likeCount };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  public async homeTimeline(
    viewerId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<TimelineView> {
    return toTimeline(await this.posts.homeTimeline({ viewerId, ...page }));
  }

  public async authorTimeline(
    viewerId: string,
    authorId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<TimelineView> {
    return toTimeline(await this.posts.authorTimeline(authorId, { viewerId, ...page }));
  }

  public async getPost(viewerId: string, postId: string): Promise<PostView> {
    const post = await this.posts.find(postId, viewerId);
    // `find` does not filter by visibility, so the check is explicit here. A post
    // the viewer may not read is reported as missing.
    if (post === null || !(await this.posts.canView(postId, viewerId))) {
      throw new DomainException(appError('NOT_FOUND', 'Post not found'));
    }
    return toView(post);
  }
}

const toView = (post: PostRecord): PostView => ({
  id: post.id,
  author: post.author,
  body: post.body,
  visibility: post.visibility,
  likeCount: post.likeCount,
  replyCount: post.replyCount,
  repostCount: post.repostCount,
  likedByMe: post.likedByMe,
  replyTo: post.replyTo,
  // Repost expansion is not implemented yet; the contract keeps the field so the
  // shape does not change when it arrives.
  repostOf: null,
  editedAt: post.editedAt === null ? null : post.editedAt.toISOString(),
  createdAt: post.createdAt.toISOString(),
});

const toTimeline = (page: { items: readonly PostRecord[]; hasMore: boolean }): TimelineView => ({
  items: page.items.map(toView),
  // Because the store reads one row beyond the page, `hasMore` is exact rather
  // than inferred from the page being full.
  nextCursor: page.hasMore ? (page.items[page.items.length - 1]?.id ?? null) : null,
});
