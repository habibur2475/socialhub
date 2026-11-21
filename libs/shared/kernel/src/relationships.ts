/**
 * Social graph and profile visibility rules.
 *
 * The decision that shapes this module: **visibility is a property of the viewer,
 * not of the profile.** Asking "is this profile public?" cannot answer "can
 * account A see account B's followers", because the answer depends on whether A
 * follows B, whether B blocked A, and what B's profile visibility is set to. All
 * three are inputs.
 *
 * The triple below captures that:
 *
 *   profileVisibility  what the owner exposes to people who are not followers
 *   isFollower         the viewer follows the owner
 *   isBlocked          the owner blocked the viewer (or the reverse)
 *
 * Blocking is checked first and defeats everything else — including a
 * pre-existing follow. That ordering is the rule most likely to be implemented
 * incorrectly, so it is the first branch and it is tested first.
 */

export const PROFILE_VISIBILITIES = ['PUBLIC', 'FOLLOWERS', 'PRIVATE'] as const;

export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number];

export const isProfileVisibility = (value: unknown): value is ProfileVisibility =>
  typeof value === 'string' && (PROFILE_VISIBILITIES as readonly string[]).includes(value);

/** The parts of a profile, ordered from least to most sensitive. */
export const PROFILE_SECTIONS = [
  'IDENTITY',
  'BIO',
  'COUNTS',
  'FOLLOWERS',
  'FOLLOWING',
  'AVATAR',
] as const;

export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

export type ViewerRelation = {
  readonly profileVisibility: ProfileVisibility;
  readonly isFollower: boolean;
  readonly isBlocked: boolean;
  /** The viewer is the owner. Always full access; checked before anything else. */
  readonly isSelf: boolean;
};

/** Sections exposed once a viewer is a confirmed follower. */
const FOLLOWER_SECTIONS: ReadonlySet<ProfileSection> = new Set([
  'IDENTITY',
  'BIO',
  'COUNTS',
  'FOLLOWERS',
  'FOLLOWING',
  'AVATAR',
]);

/**
 * Sections exposed to a stranger on a public profile.
 *
 * Follower *lists* are excluded even here: a public profile publishes its posts,
 * not a directory of its audience. Making the list opt-in prevents the "who
 * follows whom" graph scraping that has been used to out people in real life.
 */
const PUBLIC_SECTIONS: ReadonlySet<ProfileSection> = new Set([
  'IDENTITY',
  'BIO',
  'COUNTS',
  'AVATAR',
]);

/** Sections visible on a profile whose owner has chosen PRIVATE. */
const PRIVATE_SECTIONS: ReadonlySet<ProfileSection> = new Set(['IDENTITY', 'AVATAR']);

/**
 * Resolves the allowed sections for a viewer.
 *
 * Returns a rule set rather than a boolean per section, so a caller cannot
 * accidentally ask about a section that was never considered — every section
 * value in `PROFILE_SECTIONS` is reachable through exactly one branch.
 */
export const visibleSections = (relation: ViewerRelation): ReadonlySet<ProfileSection> => {
  // A block is total. Even the owner's own view of a blocked account is empty:
  // "you blocked this person" is the only thing rendered, and it is not profile
  // data.
  if (relation.isBlocked) return new Set<ProfileSection>();

  if (relation.isSelf) return new Set(PROFILE_SECTIONS);

  switch (relation.profileVisibility) {
    case 'PUBLIC':
      return relation.isFollower
        ? new Set<ProfileSection>(FOLLOWER_SECTIONS)
        : new Set<ProfileSection>(PUBLIC_SECTIONS);
    case 'FOLLOWERS':
      return relation.isFollower
        ? new Set<ProfileSection>(FOLLOWER_SECTIONS)
        : new Set<ProfileSection>(PRIVATE_SECTIONS);
    case 'PRIVATE':
      return new Set<ProfileSection>(PRIVATE_SECTIONS);
  }
};

export const canViewSection = (relation: ViewerRelation, section: ProfileSection): boolean =>
  visibleSections(relation).has(section);

/**
 * Whether a viewer may follow a target.
 *
 * Refusing to follow a blocked account is not merely cosmetic: allowing it would
 * let the blocked party keep a subscription that continues to deliver content,
 * which is the opposite of what a block means.
 */
export type FollowDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: 'SELF_FOLLOW' | 'BLOCKED' | 'TARGET_UNAVAILABLE';
    };

export const canFollow = (input: {
  readonly isSelf: boolean;
  readonly isBlocked: boolean;
  readonly targetFollowable: boolean;
}): FollowDecision => {
  if (input.isSelf) return { allowed: false, reason: 'SELF_FOLLOW' };
  if (input.isBlocked) return { allowed: false, reason: 'BLOCKED' };
  if (!input.targetFollowable) return { allowed: false, reason: 'TARGET_UNAVAILABLE' };
  return { allowed: true };
};

/** Upper bound on a single profile's outbound follows, to bound a scraping script. */
export const FOLLOW_LIMIT_PER_ACCOUNT = 7_500;

export type FollowQuotaDecision =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly reason: 'LIMIT_REACHED' };

export const canFollowMore = (
  currentFollowCount: number,
  limit: number = FOLLOW_LIMIT_PER_ACCOUNT,
): FollowQuotaDecision => {
  if (currentFollowCount >= limit) return { allowed: false, reason: 'LIMIT_REACHED' };
  return { allowed: true, remaining: limit - currentFollowCount };
};
