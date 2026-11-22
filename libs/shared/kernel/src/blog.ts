/**
 * Blog rules — publication state, editorial ordering, reading time.
 *
 * A blog is not "a post with a longer body". Three decisions make it a different
 * feature, and each of them is a rule here rather than a convention in a service:
 *
 *   1. **Publication is a state machine, not a boolean.** `DRAFT → SCHEDULED →
 *      PUBLISHED → ARCHIVED`, with `PUBLISHED → DRAFT` as the one retreat. A boolean
 *      cannot distinguish "saved at 3am, not ready" from "was live last week and taken
 *      down", and those two need different words in the UI and different answers from a
 *      reader's bookmark.
 *   2. **A scheduled article becomes public when its time arrives, and not before.**
 *      The clock is a parameter, resolved once at the edge of the request, so a test can
 *      ask "is this visible at 09:59?" without waiting for 10:00.
 *   3. **A slug is permanent.** It is what a link, a share and a search result point at.
 *      Renaming a published article's title does not move its URL; changing the slug is
 *      a separate, deliberate action, and the old slug is what a redirect is built from.
 *
 * The body is prose, so the limits are generous (100 kB, 200 characters of excerpt) and
 * the excerpt is *derived*, not required: an author who writes a title and a body must
 * not also have to write a summary to publish.
 */

export const ARTICLE_TITLE_MIN_LENGTH = 3;
export const ARTICLE_TITLE_MAX_LENGTH = 160;

/** 100 kB of prose. Past this a single request is a database row nobody can page over. */
export const ARTICLE_BODY_MAX_LENGTH = 100_000;

/** An excerpt is a glance, not the article: 200 characters renders as two lines. */
export const ARTICLE_EXCERPT_MAX_LENGTH = 200;

export const ARTICLE_AUTHOR_BIO_MAX_LENGTH = 280;

export const ARTICLE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ARTICLE_SLUG_MIN_LENGTH = 3;
export const ARTICLE_SLUG_MAX_LENGTH = 80;

export const ARTICLE_TAGS_MAX = 5;
export const ARTICLE_TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Words per minute used for the reading-time estimate.
 *
 * 200 is the figure reading research keeps landing on for prose read on a screen, and
 * it is deliberately low: an estimate that says "4 min" and takes 6 is a broken promise,
 * while one that says 5 and takes 4 is merely generous.
 */
export const WORDS_PER_MINUTE = 200;

export const ARTICLE_STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

/** The statuses a reader can reach without being the author. */
export const READER_VISIBLE_STATUSES: readonly ArticleStatus[] = ['PUBLISHED'];

/**
 * The legal moves.
 *
 * `ARCHIVED` is reachable from both `DRAFT` and `PUBLISHED`: an author may abandon a
 * draft without deleting it, and may retire a published article while keeping its URL
 * answering. Nothing leaves `ARCHIVED` — an archived article is a tombstone with a
 * body, and resurrecting one would silently reuse a slug that readers have seen die.
 */
const TRANSITIONS: Readonly<Record<ArticleStatus, readonly ArticleStatus[]>> = {
  DRAFT: ['SCHEDULED', 'PUBLISHED', 'ARCHIVED'],
  // `SCHEDULED → SCHEDULED` is a reschedule. It is listed explicitly rather than left to
  // a separate route: moving the date is the same act as setting it, and the article's
  // state does not change — so a client that corrects a typo'd time is not forced to
  // publish early and then un-publish to get back to a schedule.
  SCHEDULED: ['SCHEDULED', 'PUBLISHED', 'DRAFT', 'ARCHIVED'],
  PUBLISHED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: [],
};

export type PublishRefusal =
  | 'INVALID_TRANSITION'
  | 'NOTHING_TO_PUBLISH'
  | 'SCHEDULE_IN_THE_PAST'
  | 'SCHEDULE_WITHOUT_DATE';

export type TransitionDecision =
  | {
      readonly allowed: true;
      /** The instant the article becomes readable, or null while it stays unreadable. */
      readonly publishedAt: Date | null;
    }
  | { readonly allowed: false; readonly reason: PublishRefusal };

/**
 * Whether an article may move from `from` to `to`.
 *
 * `now` is passed in rather than read here, for the same reason every other clock in
 * this codebase is injected: a rule that reads the wall clock cannot be tested at a
 * boundary, and "scheduled for 10:00" is exactly a boundary.
 *
 * Scheduling into the past is refused instead of being silently treated as "publish
 * now": the author asked for a specific moment, and quietly doing something else is how
 * a queue of articles appears in the wrong order.
 */
export const decideTransition = (input: {
  readonly from: ArticleStatus;
  readonly to: ArticleStatus;
  /** The article has a title and a non-empty body. */
  readonly complete: boolean;
  readonly scheduledFor: Date | null;
  readonly now: Date;
}): TransitionDecision => {
  if (!TRANSITIONS[input.from].includes(input.to)) {
    return { allowed: false, reason: 'INVALID_TRANSITION' };
  }

  // Everything except a retreat to DRAFT or ARCHIVED produces something a reader can
  // reach, so it needs something to read.
  if ((input.to === 'PUBLISHED' || input.to === 'SCHEDULED') && !input.complete) {
    return { allowed: false, reason: 'NOTHING_TO_PUBLISH' };
  }

  if (input.to === 'SCHEDULED') {
    if (input.scheduledFor === null) return { allowed: false, reason: 'SCHEDULE_WITHOUT_DATE' };
    if (input.scheduledFor.getTime() <= input.now.getTime()) {
      return { allowed: false, reason: 'SCHEDULE_IN_THE_PAST' };
    }
    return { allowed: true, publishedAt: null };
  }

  if (input.to === 'PUBLISHED') {
    // Republishing keeps the original moment if there is one: an article that was live
    // last year and corrected today is still a year old, and moving its date would
    // silently reorder every archive it appears in.
    return { allowed: true, publishedAt: input.scheduledFor ?? input.now };
  }

  return { allowed: true, publishedAt: null };
};

/**
 * Whether a scheduled article is readable at `now`.
 *
 * Publication is decided by the clock, not by a worker flipping a column: a scheduled
 * article that is due is readable even if the process that was meant to publish it
 * restarted. The status is the author's intent; the timestamp is the fact.
 */
export const isDue = (input: {
  readonly status: ArticleStatus;
  readonly publishedAt: Date | null;
  readonly scheduledFor: Date | null;
  readonly now: Date;
}): boolean => {
  if (input.status === 'PUBLISHED') return true;
  if (input.status !== 'SCHEDULED') return false;

  const due = input.scheduledFor ?? input.publishedAt;
  return due !== null && due.getTime() <= input.now.getTime();
};

/** The status a reader sees, which is not always the status stored. */
export const effectiveStatus = (input: {
  readonly status: ArticleStatus;
  readonly publishedAt: Date | null;
  readonly scheduledFor: Date | null;
  readonly now: Date;
}): ArticleStatus => {
  if (input.status === 'SCHEDULED' && isDue(input)) return 'PUBLISHED';
  return input.status;
};

/**
 * Whether an article may be read by `viewer`.
 *
 * The author reads their own article in any state — that is what a preview is. Everyone
 * else reads it only once it is due, and a block between the reader and the author hides
 * it in both directions, exactly as it does for a post: the block is checked by the
 * database function, so it is applied to the list and the detail together.
 */
export const canReadArticle = (input: {
  readonly status: ArticleStatus;
  readonly publishedAt: Date | null;
  readonly scheduledFor: Date | null;
  readonly authorId: string;
  readonly viewerId: string;
  readonly now: Date;
}): boolean => {
  if (input.authorId === input.viewerId) return true;
  return (
    effectiveStatus(input) === 'PUBLISHED' && isDue({ ...input, status: effectiveStatus(input) })
  );
};

/**
 * A URL-safe slug from a title.
 *
 * Diacritics are decomposed and stripped so `Café Society` becomes `cafe-society`
 * rather than `caf-society`; everything that is not a letter or a digit collapses into a
 * single hyphen. A title written entirely in a non-Latin script produces nothing here,
 * which is what `fallbackSlug` is for — a Bengali title must still be linkable, and a
 * transliteration table is a project of its own.
 */
export const slugify = (title: string): string => {
  const normalised = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase();

  return normalised
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, ARTICLE_SLUG_MAX_LENGTH)
    .replace(/-+$/u, '');
};

/**
 * A slug that is always usable.
 *
 * `suffix` is the caller's uniqueness token — the article id, shortened. The fallback is
 * deterministic so that two runs of the same request produce the same URL and a retried
 * create does not leak a second slug.
 */
export const fallbackSlug = (suffix: string): string =>
  `article-${suffix.replace(/[^a-z0-9]/gu, '')}`;

export const slugFor = (title: string, suffix: string): string => {
  const candidate = slugify(title);
  return candidate.length >= ARTICLE_SLUG_MIN_LENGTH ? candidate : fallbackSlug(suffix);
};

/**
 * The excerpt a reader sees in a list.
 *
 * Derived from the body rather than stored as a field the author must fill: the first
 * paragraph is what an author would write anyway, and a required summary is a form field
 * that stops a draft from being publishable for no reader-facing reason.
 *
 * Markdown is not parsed here — this is a preview, and the rules that matter are that
 * line breaks collapse (a list rendered into one line reads as prose), heading marks and
 * emphasis markers are dropped (an excerpt that begins with `##` is a bug), and a
 * truncated excerpt ends with an ellipsis rather than a half word.
 */
export const excerptOf = (body: string, max: number = ARTICLE_EXCERPT_MAX_LENGTH): string => {
  const flat = body
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/^\s*[-*+]\s+/gmu, '')
    .replace(/^\s*>\s?/gmu, '')
    .replace(/[*_`~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

  const characters = [...flat];
  if (characters.length <= max) return flat;

  // Cut on a word boundary when one is close enough, because "…the sec…" reads worse
  // than a slightly shorter excerpt that ends on a whole word.
  const clipped = characters.slice(0, max - 1).join('');
  const lastSpace = clipped.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped;
  return `${cut.trimEnd()}…`;
};

/**
 * Reading time in whole minutes, rounded up.
 *
 * A 30-second article says "1 min", never "0 min": a zero reads as "nothing to read"
 * rather than "quick". Code blocks count, because they take time to read too.
 */
export const readingMinutes = (body: string): number => {
  const words = body
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0).length;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
};

/**
 * Normalises a tag list.
 *
 * Lowercased, trimmed, deduplicated and capped, in that order. A tag is an index entry,
 * so `PostgreSQL`, `postgresql` and ` postgresql ` must be one tag — otherwise the tag
 * cloud grows a duplicate for every author's typing habits.
 */
export const normaliseTags = (tags: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().replace(/\s+/gu, '-');
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length === ARTICLE_TAGS_MAX) break;
  }

  return result;
};

/**
 * Whether a body contains an unclosed code fence.
 *
 * An odd number of triple backticks is the single most common Markdown mistake, and it
 * is the one that silently corrupts every heading after it. Refusing it at write time is
 * cheaper than explaining the rendered result later.
 */
export const hasUnbalancedFence = (body: string): boolean => {
  const fences = body.match(/^```/gmu);
  return fences !== null && fences.length % 2 !== 0;
};

export type ArticleDraftDecision =
  | { readonly allowed: true; readonly title: string; readonly body: string }
  | {
      readonly allowed: false;
      readonly reason: 'EMPTY_TITLE' | 'TITLE_TOO_LONG' | 'EMPTY_BODY' | 'BODY_TOO_LONG';
    };

/**
 * Normalises and validates the two fields an article cannot exist without.
 *
 * The title is trimmed and its internal whitespace collapsed — a title is a single line
 * of text, and a stray newline in it breaks every list it appears in. The body keeps its
 * line breaks for the same reason a post does: a code block's indentation is content.
 */
export const prepareArticle = (input: {
  readonly title: string;
  readonly body: string;
}): ArticleDraftDecision => {
  const title = input.title.trim().replace(/\s+/gu, ' ');
  const body = input.body.trim();

  if (title.length === 0) return { allowed: false, reason: 'EMPTY_TITLE' };
  if ([...title].length > ARTICLE_TITLE_MAX_LENGTH)
    return { allowed: false, reason: 'TITLE_TOO_LONG' };
  if (body.length === 0) return { allowed: false, reason: 'EMPTY_BODY' };
  if ([...body].length > ARTICLE_BODY_MAX_LENGTH)
    return { allowed: false, reason: 'BODY_TOO_LONG' };

  return { allowed: true, title, body };
};
