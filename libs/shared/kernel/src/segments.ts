/**
 * Audience segmentation and ad placement rules.
 *
 * Placement is a pure decision over an audience profile plus the placement slot,
 * which keeps ad revenue accounting explainable: for any impression the platform
 * can prove why a given campaign was eligible.
 */

export const PLACEMENTS = [
  'FEED_INLINE',
  'FEED_SIDEBAR',
  'BLOG_INLINE',
  'BLOG_SIDEBAR',
  'QUIZ_LEADERBOARD',
  'QUIZ_BETWEEN_QUESTIONS',
  'MARKETPLACE_GRID',
  'MARKETPLACE_DETAIL',
  'JOB_LISTING',
  'JOB_DETAIL',
  'SEARCH_RESULTS',
] as const;

export type Placement = (typeof PLACEMENTS)[number];

export type AudienceProfile = {
  /** Canonical interest slugs, e.g. "technology", "education". */
  readonly interests: readonly string[];
  readonly countryCode: string | null;
  readonly language: string;
  readonly ageBand: '13-17' | '18-24' | '25-34' | '35-44' | '45-54' | '55+' | null;
};

export type CampaignTargeting = {
  readonly placements: readonly Placement[];
  readonly interests: readonly string[];
  readonly countries: readonly string[];
  readonly languages: readonly string[];
  readonly ageBands: readonly AudienceProfile['ageBand'][];
  /** Minimum relevance score in basis points required to serve. */
  readonly minRelevanceBps: number;
};

export type BidContext = {
  readonly placement: Placement;
  readonly audience: AudienceProfile;
  readonly relevanceBps: number;
  readonly dailyBudgetRemainingMinor: number;
  readonly bidCpmMinor: number;
};

const matchesAny = (criteria: readonly string[], value: string | null): boolean =>
  criteria.length === 0 || (value !== null && criteria.includes(value));

/** Returns true when the campaign is eligible for this audience and placement. */
export const isEligible = (targeting: CampaignTargeting, placement: Placement, audience: AudienceProfile): boolean => {
  if (targeting.placements.length > 0 && !targeting.placements.includes(placement)) return false;
  if (!matchesAny(targeting.languages, audience.language)) return false;
  if (targeting.countries.length > 0 && !matchesAny(targeting.countries, audience.countryCode)) return false;
  if (targeting.ageBands.length > 0 && (audience.ageBand === null || !targeting.ageBands.includes(audience.ageBand))) {
    return false;
  }
  if (targeting.interests.length > 0 && !audience.interests.some((interest) => targeting.interests.includes(interest))) {
    return false;
  }
  return true;
};

/**
 * Relevance in basis points, from interest overlap and placement affinity.
 *
 * Overlap dominates (7000 bps) because declared interest is the strongest
 * signal; placement affinity contributes the remainder. Values are bounded to
 * [0, 10000] and integers, so downstream budget maths stays exact.
 */
export const relevanceScore = (
  targeting: Pick<CampaignTargeting, 'interests'>,
  placement: Placement,
  audience: AudienceProfile,
): number => {
  const overlap =
    targeting.interests.length === 0
      ? 5_000
      : (Math.min(audience.interests.filter((interest) => targeting.interests.includes(interest)).length, targeting.interests.length) *
          7_000) /
        targeting.interests.length;

  const affinity: Record<Placement, number> = {
    FEED_INLINE: 2_500,
    FEED_SIDEBAR: 1_500,
    BLOG_INLINE: 2_000,
    BLOG_SIDEBAR: 1_200,
    QUIZ_LEADERBOARD: 1_800,
    QUIZ_BETWEEN_QUESTIONS: 1_600,
    MARKETPLACE_GRID: 2_200,
    MARKETPLACE_DETAIL: 2_400,
    JOB_LISTING: 2_300,
    JOB_DETAIL: 2_600,
    SEARCH_RESULTS: 2_900,
  };

  return Math.max(0, Math.min(10_000, Math.round(overlap + (affinity[placement] * 3_000) / 2_900)));
};

/** Effective cost per mille after budget pacing; zero when the campaign is exhausted. */
export const pacedBidCpm = (context: BidContext): number => {
  if (context.dailyBudgetRemainingMinor <= 0) return 0;
  if (context.relevanceBps <= 0) return 0;
  return Math.floor((context.bidCpmMinor * context.relevanceBps) / 10_000);
};
