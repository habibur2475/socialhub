/**
 * Blog ports.
 *
 * One store, because reading the archive and writing an article touch the same two
 * tables and the same visibility function. The split that matters is not read/write here
 * but *who is asking*: the list, the detail and `mine` all call `can_view_article()`,
 * so an article that is invisible to a reader is `null` from every route at once.
 *
 * `now` is a parameter on every read rather than `new Date()` inside the adapter. A
 * scheduled article is readable at a moment, that moment is a boundary, and a boundary
 * that the adapter reads from the wall clock cannot be tested.
 */

import type { ArticleStatus } from '@socialhub/kernel';

export type ArticleAuthorRecord = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
  readonly bio: string | null;
};

export type ArticleRecord = {
  readonly id: string;
  readonly authorId: string;
  readonly author: ArticleAuthorRecord;
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly excerpt: string;
  readonly readingMinutes: number;
  readonly tags: readonly string[];
  readonly status: ArticleStatus;
  readonly publishedAt: Date | null;
  readonly scheduledFor: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ArticlePage = {
  readonly items: readonly ArticleRecord[];
  readonly hasMore: boolean;
};

export type ArticleListQuery = {
  readonly viewerId: string;
  readonly limit: number;
  readonly cursor: string | null;
  readonly tag: string | null;
  readonly authorUsername: string | null;
  /** Only the caller's own articles, in every status. */
  readonly mine: boolean;
  readonly now: Date;
};

export type ArticleTagRecord = {
  readonly tag: string;
  readonly articleCount: number;
};

export type ArticleStore = {
  /**
   * The archive.
   *
   * A `SLUG`-free read: ordering is `published_at DESC, id DESC` with the id as the
   * tie-breaker, because two articles can share a publication instant (a batch import,
   * a backfill) and a cursor on the timestamp alone would skip one of them.
   */
  list(query: ArticleListQuery): Promise<ArticlePage>;

  /**
   * Null when the article does not exist or the viewer may not read it.
   *
   * Accepts an id or a slug. Due-ness is decided by the database's `now()`, so there is
   * no clock parameter: one request sees one transaction timestamp.
   */
  find(viewerId: string, idOrSlug: string): Promise<ArticleRecord | null>;

  /** True when the slug is taken — by any article, including the caller's own. */
  slugTaken(slug: string): Promise<boolean>;

  create(input: {
    readonly id: string;
    readonly authorId: string;
    readonly slug: string;
    readonly title: string;
    readonly body: string;
    readonly excerpt: string;
    readonly readingMinutes: number;
    readonly tags: readonly string[];
  }): Promise<ArticleRecord>;

  /**
   * Updates the editable fields and replaces the tag set.
   *
   * Returns null when the article is not the caller's, so ownership is one predicate in
   * one statement rather than a read, a comparison and an update.
   */
  update(input: {
    readonly id: string;
    readonly authorId: string;
    readonly slug: string | null;
    readonly title: string | null;
    readonly body: string | null;
    readonly excerpt: string | null;
    readonly readingMinutes: number | null;
    readonly tags: readonly string[] | null;
  }): Promise<ArticleRecord | null>;

  /** Applies a decided transition. Null when the article is not the caller's. */
  setStatus(input: {
    readonly id: string;
    readonly authorId: string;
    readonly status: ArticleStatus;
    readonly publishedAt: Date | null;
    readonly scheduledFor: Date | null;
  }): Promise<ArticleRecord | null>;

  delete(id: string, authorId: string): Promise<boolean>;

  /** The tag cloud: every tag with at least one article a reader can reach. */
  listTags(): Promise<readonly ArticleTagRecord[]>;
};
