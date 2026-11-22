/**
 * Blog contracts.
 *
 * The status list is imported from the kernel rather than restated: the CHECK constraint,
 * the transition table and this schema must agree, and a fourth copy of a four-value enum
 * is a fourth chance to disagree.
 *
 * Three shapes with different jobs:
 *
 *   the *summary*   what a list renders: title, slug, excerpt, reading time, author. It
 *                   deliberately carries no body — an archive of 20 articles must not
 *                   download 20 bodies to show 20 two-line previews.
 *   the *article*   the summary plus the body, returned only by the detail route.
 *   the *draft*     the summary plus the edit-only fields (`scheduledFor`), because an
 *                   author editing an article needs to know when it is due, and a reader
 *                   does not.
 */

import { z } from 'zod';

import {
  ARTICLE_BODY_MAX_LENGTH,
  ARTICLE_EXCERPT_MAX_LENGTH,
  ARTICLE_SLUG_MAX_LENGTH,
  ARTICLE_STATUSES,
  ARTICLE_TAGS_MAX,
  ARTICLE_TITLE_MAX_LENGTH,
  ARTICLE_TITLE_MIN_LENGTH,
} from '@socialhub/kernel/browser';

/** Re-exported, not restated: the kernel decides what the limits mean. */
export {
  ARTICLE_BODY_MAX_LENGTH,
  ARTICLE_EXCERPT_MAX_LENGTH,
  ARTICLE_SLUG_MAX_LENGTH,
  ARTICLE_STATUSES,
  ARTICLE_TAGS_MAX,
  ARTICLE_TITLE_MAX_LENGTH,
  ARTICLE_TITLE_MIN_LENGTH,
};
export type { ArticleStatus } from '@socialhub/kernel/browser';

const slugSchema = z
  .string()
  .trim()
  .min(3)
  .max(ARTICLE_SLUG_MAX_LENGTH)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase letters, digits and single hyphens');

/**
 * A tag, folded before it is validated.
 *
 * The shape rule is lowercase-and-hyphens, but the *input* is what a person typed: `Monorepo`
 * and `monorepo` and `monorepo` with a space in it are the same tag, and rejecting
 * `State Management` for its capital letter would be a rule enforced at the worst possible
 * moment — after the author wrote 800 words. So the transform folds the tag and the regex
 * then checks the folded value, which is exactly what `normaliseTags` stores.
 */
const tagSchema = z
  .string()
  .trim()
  .min(1, 'A tag cannot be empty')
  .max(64)
  .transform((tag) =>
    tag
      .toLowerCase()
      .replace(/\s+/gu, '-')
      .replace(/^-+|-+$/gu, ''),
  )
  .pipe(
    z
      .string()
      .min(1, 'A tag cannot be empty')
      .max(40)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase letters, digits and single hyphens'),
  );

/**
 * Creating an article.
 *
 * `slug` is optional: when it is absent the server derives one from the title, and the
 * client never has to know the slug regex. When it is present it is honoured verbatim, so
 * an author who cares about the URL can choose it — and a collision is a `409`, not a
 * silent suffix.
 */
export const createArticleRequestSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(
        ARTICLE_TITLE_MIN_LENGTH,
        `A title needs at least ${ARTICLE_TITLE_MIN_LENGTH} characters`,
      )
      .max(ARTICLE_TITLE_MAX_LENGTH),
    body: z.string().min(1, 'Write something first').max(ARTICLE_BODY_MAX_LENGTH),
    slug: slugSchema.optional(),
    tags: z
      .array(tagSchema)
      .max(ARTICLE_TAGS_MAX * 2)
      .optional(),
  })
  .strict();

export type CreateArticleRequest = z.infer<typeof createArticleRequestSchema>;

/**
 * Editing an article.
 *
 * Every field is optional because a `PATCH` may change one thing, but at least one must
 * be present: a request that changes nothing is a client bug worth surfacing, not a
 * no-op that silently succeeds.
 */
export const updateArticleRequestSchema = z
  .object({
    title: z.string().trim().min(ARTICLE_TITLE_MIN_LENGTH).max(ARTICLE_TITLE_MAX_LENGTH).optional(),
    body: z.string().min(1).max(ARTICLE_BODY_MAX_LENGTH).optional(),
    slug: slugSchema.optional(),
    tags: z
      .array(tagSchema)
      .max(ARTICLE_TAGS_MAX * 2)
      .optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.title !== undefined ||
      body.body !== undefined ||
      body.slug !== undefined ||
      body.tags !== undefined,
    'Nothing to change',
  );

export type UpdateArticleRequest = z.infer<typeof updateArticleRequestSchema>;

/**
 * A status change.
 *
 * `scheduledFor` is required for `SCHEDULED` and ignored otherwise — the database's
 * `articles_schedule_pairing` constraint enforces the same pairing, so a client that
 * sends a stray date is corrected rather than stored inconsistently.
 */
export const publishArticleRequestSchema = z
  .object({
    status: z.enum(['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED']),
    scheduledFor: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type PublishArticleRequest = z.infer<typeof publishArticleRequestSchema>;

/**
 * The archive query.
 *
 * `tag` and `author` are filters rather than separate routes: "this tag's articles" and
 * "this author's articles" are the same page with one predicate, and two routes would be
 * two pagination implementations.
 */
export const articleQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    /** Keyset cursor: the `publishedAt` and id of the last row, `|`-separated. */
    cursor: z.string().max(120).optional(),
    tag: tagSchema.optional(),
    /** A username, not an account id: it is what a profile URL already contains. */
    author: z.string().trim().min(2).max(40).optional(),
    /** Only the caller's own articles, in every status. Author-only. */
    mine: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export type ArticleQuery = z.infer<typeof articleQuerySchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type ArticleAuthorResponse = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
  readonly bio: string | null;
};

/** What a list renders. No body: see the header. */
export type ArticleSummaryResponse = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly excerpt: string;
  readonly readingMinutes: number;
  readonly tags: readonly string[];
  readonly author: ArticleAuthorResponse;
  /** The stored status; `PUBLISHED` for a scheduled article that is already due. */
  readonly status: (typeof ARTICLE_STATUSES)[number];
  readonly publishedAt: string | null;
  /** The caller's own article: the flag that shows the edit controls. */
  readonly isAuthor: boolean;
  /** Set on the author's own draft: when it becomes readable, if it is scheduled. */
  readonly scheduledFor: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** The detail route's shape: everything above, plus the prose. */
export type ArticleResponse = ArticleSummaryResponse & {
  readonly body: string;
};

export type ArticleListResponse = {
  readonly items: readonly ArticleSummaryResponse[];
  readonly nextCursor: string | null;
};

export type ArticleTagResponse = {
  readonly tag: string;
  readonly articleCount: number;
};

export type ArticleTagListResponse = {
  readonly items: readonly ArticleTagResponse[];
};

/** Kinds of refusal a status change can produce, for the UI's wording. */
export const ARTICLE_PUBLISH_FAILURES = [
  'INVALID_TRANSITION',
  'NOTHING_TO_PUBLISH',
  'SCHEDULE_IN_THE_PAST',
  'SCHEDULE_WITHOUT_DATE',
] as const;

export type ArticlePublishFailure = (typeof ARTICLE_PUBLISH_FAILURES)[number];
