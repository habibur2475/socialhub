/**
 * Forum contracts.
 *
 * The forum is deliberately *not* a second feed. It has categories, one level of
 * answers, and an accepted answer — and no likes, reposts or follower visibility.
 * A thread is readable by anyone signed in unless a block exists, which is the
 * rule `can_view_thread()` enforces in the database; a category is always public.
 *
 * Categories are addressed by `path` (`/general/help`) rather than by id: a path
 * is what a link contains, what a moderator recognises, and what stays stable
 * when a category is re-parented and its id-and-slug pair would change.
 */

import { z } from 'zod';

export const FORUM_CATEGORY_SLUG_PATTERN = /^[a-z0-9-]{2,40}$/;

/** Mirrors `forum_categories.path_shape`. */
export const FORUM_CATEGORY_PATH_PATTERN = /^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/;

export const FORUM_TITLE_MIN_LENGTH = 3;
export const FORUM_TITLE_MAX_LENGTH = 160;
export const FORUM_BODY_MAX_LENGTH = 20_000;

/**
 * The body limits are 20 kB, which is a *deliberate* ceiling rather than a
 * comfortable one: a forum answer is prose, not an essay, and an unbounded body is
 * how a single request becomes a database row nobody can page over.
 */
export const createThreadRequestSchema = z
  .object({
    categoryId: z.string().uuid(),
    title: z
      .string()
      .trim()
      .min(FORUM_TITLE_MIN_LENGTH, `A title needs at least ${FORUM_TITLE_MIN_LENGTH} characters`)
      .max(FORUM_TITLE_MAX_LENGTH),
    body: z.string().trim().min(1, 'Write something first').max(FORUM_BODY_MAX_LENGTH),
  })
  .strict();

export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

export const createAnswerRequestSchema = z
  .object({
    body: z.string().trim().min(1, 'Write something first').max(FORUM_BODY_MAX_LENGTH),
  })
  .strict();

export type CreateAnswerRequest = z.infer<typeof createAnswerRequestSchema>;

export const threadQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().uuid().optional(),
    /** Filter by category path, e.g. `/general/help`. */
    category: z.string().regex(FORUM_CATEGORY_PATH_PATTERN, 'Not a category path').optional(),
  })
  .strict();

export type ThreadQuery = z.infer<typeof threadQuerySchema>;

export const answerQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().uuid().optional(),
  })
  .strict();

export type AnswerQuery = z.infer<typeof answerQuerySchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type ForumAuthorResponse = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
};

export type ForumCategoryResponse = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly path: string;
  readonly threadCount: number;
};

export type ForumThreadSummaryResponse = {
  readonly id: string;
  readonly categoryId: string;
  readonly categoryPath: string;
  readonly title: string;
  readonly author: ForumAuthorResponse;
  readonly answerCount: number;
  readonly pinned: boolean;
  readonly locked: boolean;
  /** True when the latest answer is newer than the thread's own last edit. */
  readonly hasAcceptedAnswer: boolean;
  readonly lastActivityAt: string;
  readonly createdAt: string;
};

export type ForumThreadResponse = ForumThreadSummaryResponse & {
  readonly body: string;
  /** The caller may accept an answer: they wrote the thread and none is accepted. */
  readonly canAcceptAnswer: boolean;
};

export type ForumAnswerResponse = {
  readonly id: string;
  readonly threadId: string;
  readonly author: ForumAuthorResponse;
  readonly body: string;
  readonly accepted: boolean;
  readonly createdAt: string;
  /** The caller wrote this answer and may delete it. */
  readonly canDelete: boolean;
};

export type ForumThreadListResponse = {
  readonly items: readonly ForumThreadSummaryResponse[];
  readonly nextCursor: string | null;
};

export type ForumAnswerListResponse = {
  readonly items: readonly ForumAnswerResponse[];
  readonly nextCursor: string | null;
};

/** A thread and its first page of answers, so opening a thread is one request. */
export type ForumThreadDetailResponse = {
  readonly thread: ForumThreadResponse;
  readonly answers: readonly ForumAnswerResponse[];
  readonly nextCursor: string | null;
};
