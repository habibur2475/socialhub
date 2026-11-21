/**
 * Feed composition rules.
 *
 * The database owns *who may see a post* (`can_view_post`). This module owns the
 * decisions that are cheaper and clearer in code: what may be written, how a post
 * is addressed to an audience, and how a timeline is assembled from the pieces a
 * client needs to render it.
 *
 * Keeping the split here rather than in the service means the rules can be tested
 * without a database, and the same rules can be reused by the future Go/Elasticsearch
 * search path without re-deriving them.
 */

export const POST_BODY_MAX_LENGTH = 5_000;

/** How many days back the home timeline will read before giving up. */
export const TIMELINE_WINDOW_DAYS = 7;

/** Hard ceiling on a single timeline page, regardless of what a client asks for. */
export const TIMELINE_PAGE_MAX = 50;

/**
 * Audience strategy for a post.
 *
 *   PUBLIC    : addressed to everyone, so no rows are written and every read path
 *               may return it. Materialising "everyone" would be unbounded.
 *   FOLLOWERS : addressed to the accepted followers that exist *now*.
 *   PRIVATE   : addressed to nobody but the author; still written to the feed table
 *               so it can be edited and deleted through the same paths, but it can
 *               never enter another account's timeline.
 */
export type PostAudience = 'PUBLIC' | 'FOLLOWERS' | 'PRIVATE';

export type PostDraft = {
  readonly body: string;
  readonly visibility: PostAudience;
  readonly replyTo: string | null;
};

export type DraftDecision =
  | { readonly allowed: true; readonly body: string }
  | { readonly allowed: false; readonly reason: 'EMPTY' | 'TOO_LONG' };

/**
 * Normalises and validates a post body.
 *
 * The body is trimmed but *internal* whitespace is preserved: a poem's line
 * breaks and a code block's indentation are content. Only leading and trailing
 * whitespace is discarded, because a body of nothing but spaces is not a post.
 */
export const prepareBody = (raw: string): DraftDecision => {
  const body = raw.trim();

  if (body.length === 0) return { allowed: false, reason: 'EMPTY' };
  // Length is measured in code points, not UTF-16 units: an emoji is one
  // character to the author even though it occupies two units in JavaScript.
  if ([...body].length > POST_BODY_MAX_LENGTH) return { allowed: false, reason: 'TOO_LONG' };

  return { allowed: true, body };
};

/**
 * Whether a post's audience must be materialised as rows.
 *
 * Only FOLLOWERS does. PUBLIC is unbounded and PRIVATE has exactly one member —
 * the author — who is resolved by `posts.account_id` without a row.
 */
export const requiresAudienceRows = (visibility: PostAudience): boolean =>
  visibility === 'FOLLOWERS';

/**
 * Effective visibility of a reply.
 *
 * A reply can never be *wider* than its parent. Replying publicly to a
 * followers-only post would let the reply text be read by people the parent was
 * hidden from, which is a disclosure the parent's author never agreed to. The
 * narrower of the two wins.
 */
const VISIBILITY_RANK: Readonly<Record<PostAudience, number>> = {
  PRIVATE: 0,
  FOLLOWERS: 1,
  PUBLIC: 2,
};

export const effectiveReplyVisibility = (
  requested: PostAudience,
  parent: PostAudience,
): PostAudience => (VISIBILITY_RANK[requested] <= VISIBILITY_RANK[parent] ? requested : parent);

/**
 * Ranking used by the home timeline.
 *
 * Chronological ordering is correct but poor: an account that posts twenty times
 * in a minute erases everyone else. The rank below is a fixed, explainable
 * adjustment — recent first, with a bounded bonus for engagement — rather than a
 * learned model we cannot debug in a postmortem.
 *
 * The half-life means a post from six hours ago needs roughly four times the
 * engagement of a fresh one to rank equally, which is a deliberate, checkable
 * curve.
 */
export const ENGAGEMENT_HALF_LIFE_HOURS = 6;

export const timelineScore = (input: {
  readonly ageHours: number;
  readonly likeCount: number;
  readonly replyCount: number;
  readonly repostCount: number;
}): number => {
  const age = Math.max(input.ageHours, 0);
  const decay = Math.pow(0.5, age / ENGAGEMENT_HALF_LIFE_HOURS);
  // Replies weigh more than likes: they cost the reader more effort and they are
  // the signal that a conversation is happening.
  const engagement = input.likeCount + input.replyCount * 2 + input.repostCount * 3;
  // Logarithmic so a viral post cannot pin the top of the feed indefinitely; the
  // decay term still governs the final ordering.
  return decay * (1 + Math.log10(1 + engagement));
};

/** Whether a post is old enough to fall out of the home timeline window. */
export const isWithinTimelineWindow = (createdAt: Date, now: Date): boolean =>
  now.getTime() - createdAt.getTime() <= TIMELINE_WINDOW_DAYS * 24 * 60 * 60 * 1_000;

/**
 * Clamps a requested page size.
 *
 * A client asking for 1000 items gets the maximum, not an error and not 1000:
 * an error punishes a plausible mistake, and honouring it lets one request
 * exhaust the connection pool.
 */
export const clampPageSize = (requested: number | undefined, fallback = 20): number => {
  if (requested === undefined) return fallback;
  if (!Number.isFinite(requested)) return fallback;
  return Math.min(Math.max(Math.trunc(requested), 1), TIMELINE_PAGE_MAX);
};
