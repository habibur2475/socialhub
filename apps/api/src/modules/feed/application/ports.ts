/**
 * Feed ports.
 *
 * The read path is deliberately two ports, not one. Writing a post and reading a
 * timeline are different problems with different failure modes, and the timeline
 * will eventually be served by a different store (a fan-out service and later
 * Elasticsearch) while post writes stay on Postgres. Separating them now means
 * that swap touches one adapter.
 */

import type { PostAudience } from '@socialhub/kernel';

export type PostAuthor = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
};

/** A post as stored, before any redaction. */
export type PostRecord = {
  readonly id: string;
  readonly authorId: string;
  readonly body: string;
  readonly visibility: PostAudience;
  readonly likeCount: number;
  readonly replyCount: number;
  readonly repostCount: number;
  readonly replyTo: string | null;
  readonly repostOf: string | null;
  readonly editedAt: Date | null;
  readonly createdAt: Date;
  readonly author: PostAuthor;
  readonly likedByMe: boolean;
};

/**
 * What a timeline read needs.
 *
 * `viewerId` is a parameter rather than an afterthought: there is no such thing
 * as an unauthenticated timeline in this product, and making it optional would
 * invite a call site that forgets to pass it and silently gets the public view.
 */
export type TimelineQuery = {
  readonly viewerId: string;
  readonly limit: number;
  readonly cursor: string | null;
};

export type TimelinePage = {
  readonly items: readonly PostRecord[];
  readonly hasMore: boolean;
};

export type PostStore = {
  /** Returns null when the post does not exist. Visibility is the caller's job. */
  find(id: string, viewerId: string): Promise<PostRecord | null>;
  /** Persists a post and, for a FOLLOWERS audience, its audience snapshot. */
  create(input: {
    readonly id: string;
    readonly authorId: string;
    readonly body: string;
    readonly visibility: PostAudience;
    readonly replyTo: string | null;
    readonly audienceAccountIds: readonly string[];
  }): Promise<PostRecord | null>;
  /** Returns null when the viewer may not edit it (not the author, or missing). */
  updateBody(id: string, authorId: string, body: string): Promise<PostRecord | null>;
  /** Soft-invisible: the row is removed, so counters cascade. */
  remove(id: string, authorId: string): Promise<boolean>;
  /** Home timeline: the viewer's own posts plus everything addressed to them. */
  homeTimeline(query: TimelineQuery): Promise<TimelinePage>;
  /** One author's posts, filtered by what the viewer may see. */
  authorTimeline(authorId: string, query: TimelineQuery): Promise<TimelinePage>;
  /** Deletes the viewer's like on a post, or creates it. Returns the new state. */
  setLike(postId: string, accountId: string, liked: boolean): Promise<boolean>;
  /** Account ids of the author's accepted followers, for the audience snapshot. */
  acceptedFollowerIds(authorId: string): Promise<readonly string[]>;
  /** Whether the viewer may see the post, asked of the database rule. */
  canView(postId: string, viewerId: string): Promise<boolean>;
};

export type FeedClock = () => Date;

/**
 * Side effects a feed write produces, expressed as *events* rather than as
 * notifications.
 *
 * The feed does not know that a like becomes a notification row, nor that a mention
 * has to be resolved through the profile store. It states what happened; the adapter
 * decides who cares. That keeps the notification policy (blocks, entitlement,
 * collapsing) in one module and keeps this service testable with a stub.
 *
 * Every method is fire-and-forget from the caller's point of view: a notification
 * that cannot be written must not fail the post that caused it.
 */
export type FeedEvent =
  | {
      readonly type: 'POST_LIKED';
      readonly actorId: string;
      readonly postId: string;
      readonly authorId: string;
      readonly preview: string;
    }
  | {
      readonly type: 'POST_REPLIED';
      readonly actorId: string;
      readonly postId: string;
      readonly parentAuthorId: string;
      readonly body: string;
    }
  | {
      readonly type: 'POST_PUBLISHED';
      readonly actorId: string;
      readonly postId: string;
      readonly body: string;
    };

export type FeedEvents = {
  emit(event: FeedEvent): Promise<void>;
};
