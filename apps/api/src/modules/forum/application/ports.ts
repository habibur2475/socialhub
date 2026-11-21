/**
 * Forum ports.
 *
 * Thread reads apply `can_view_thread()` and answer reads inherit their thread's
 * visibility through a join — never a second, separately written predicate. That
 * matters more here than in the feed: a thread is public by default, so the only
 * thing hiding one is a block, and a block that hides the thread but not its answers
 * would leak the conversation one level down.
 *
 * A category has no author and no visibility. It is a fixture, not user content.
 */

export type ForumAuthor = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
};

export type ForumCategoryRecord = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly path: string;
  readonly threadCount: number;
};

export type ForumThreadRecord = {
  readonly id: string;
  readonly categoryId: string;
  readonly categoryPath: string;
  readonly authorId: string;
  readonly author: ForumAuthor;
  readonly title: string;
  readonly body: string;
  readonly answerCount: number;
  readonly pinned: boolean;
  readonly locked: boolean;
  readonly hasAcceptedAnswer: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ForumAnswerRecord = {
  readonly id: string;
  readonly threadId: string;
  readonly authorId: string;
  readonly author: ForumAuthor;
  readonly body: string;
  readonly accepted: boolean;
  readonly createdAt: Date;
};

export type ForumThreadPage = {
  readonly items: readonly ForumThreadRecord[];
  readonly hasMore: boolean;
};

export type ForumAnswerPage = {
  readonly items: readonly ForumAnswerRecord[];
  readonly hasMore: boolean;
};

export type ForumStore = {
  listCategories(): Promise<readonly ForumCategoryRecord[]>;
  findCategoryByPath(path: string): Promise<ForumCategoryRecord | null>;
  findCategoryById(id: string): Promise<ForumCategoryRecord | null>;

  /** Null when the thread does not exist or the viewer may not see it. */
  findThread(viewerId: string, threadId: string): Promise<ForumThreadRecord | null>;

  listThreads(
    viewerId: string,
    page: { limit: number; cursor: string | null; categoryPath: string | null },
  ): Promise<ForumThreadPage>;

  createThread(input: {
    readonly id: string;
    readonly categoryId: string;
    readonly authorId: string;
    readonly title: string;
    readonly body: string;
  }): Promise<ForumThreadRecord | null>;

  listAnswers(
    viewerId: string,
    threadId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<ForumAnswerPage>;

  createAnswer(input: {
    readonly id: string;
    readonly threadId: string;
    readonly authorId: string;
    readonly body: string;
  }): Promise<ForumAnswerRecord | null>;

  /**
   * Marks an answer accepted, clearing any previous acceptance on the same thread.
   *
   * Cleared in the same transaction because the partial unique index allows exactly
   * one accepted answer: updating the new one first would collide with the old.
   */
  acceptAnswer(input: {
    readonly threadId: string;
    readonly answerId: string;
    readonly threadAuthorId: string;
  }): Promise<ForumAnswerRecord | null>;

  /** True when the viewer owns the thread and no answer is accepted yet. */
  canAccept(threadId: string, accountId: string): Promise<boolean>;

  /** The thread's author id, for the notification recipient. Null when missing. */
  threadAuthorId(threadId: string): Promise<string | null>;
  /** The author of an answer, and its thread, for a delete check. */
  answerOwner(answerId: string): Promise<{ threadId: string; authorId: string } | null>;
  deleteAnswer(answerId: string, accountId: string): Promise<boolean>;
  isThreadLocked(threadId: string): Promise<boolean>;
};
