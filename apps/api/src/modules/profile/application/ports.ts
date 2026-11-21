/**
 * Profile and social-graph ports.
 *
 * The application layer never sees SQL. It sees these interfaces, which describe
 * *what* the use cases need, not *how* it is stored — so the queries can move to a
 * shard without touching a business rule, and the use cases can be tested without
 * a database.
 *
 * The relation between two accounts is deliberately a first-class read
 * (`relationBetween`) rather than three separate lookups: every visibility
 * decision needs all three facts at once, and fetching them separately invites a
 * call site that forgets one.
 */

import type { ProfileVisibility } from '@socialhub/kernel';

export type ProfileRecord = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  /** Present only when the viewer is allowed to see it; null means redacted. */
  readonly bio: string | null;
  readonly avatarKey: string | null;
  readonly bannerKey: string | null;
  readonly visibility: ProfileVisibility;
  readonly followerCount: number;
  readonly followingCount: number;
  readonly createdAt: Date;
};

/** The account-level facts a profile read depends on. */
export type AccountPresence = {
  readonly accountId: string;
  readonly state: string;
  readonly deleted: boolean;
};

export type RelationFacts = {
  /** The viewer follows the target and the target accepted (or auto-accepts). */
  readonly viewerFollowsTarget: boolean;
  /** A block exists in either direction. */
  readonly blocked: boolean;
  /** The follow request is pending, which matters for the button's state. */
  readonly followPending: boolean;
};

export type ProfileStore = {
  /** Returns null when the profile or its account is gone. */
  findById(accountId: string): Promise<ProfileRecord | null>;
  findByUsername(username: string): Promise<ProfileRecord | null>;
  /**
   * Updates the editable fields, returning the row as stored.
   *
   * `username` is handled separately because it is unique across the whole
   * platform: the caller needs a distinct failure (taken) rather than a generic
   * constraint error.
   */
  update(
    accountId: string,
    changes: {
      readonly displayName?: string;
      readonly bio?: string | null;
      readonly visibility?: ProfileVisibility;
    },
  ): Promise<ProfileRecord | null>;
  /** True when the username belongs to a different account. */
  usernameTaken(username: string, exceptAccountId: string): Promise<boolean>;
  changeUsername(accountId: string, username: string): Promise<ProfileRecord | null>;
};

export type SocialGraphStore = {
  relationBetween(viewerId: string, targetId: string): Promise<RelationFacts>;
  /** Idempotent: following twice is not an error. */
  follow(followerId: string, followeeId: string, accepted: boolean): Promise<void>;
  unfollow(followerId: string, followeeId: string): Promise<boolean>;
  /** Removing a pending request. */
  cancelFollowRequest(followerId: string, followeeId: string): Promise<boolean>;
  acceptFollowRequest(followerId: string, followeeId: string): Promise<boolean>;
  block(blockerId: string, blockedId: string, reason: string | null): Promise<void>;
  unblock(blockerId: string, blockedId: string): Promise<boolean>;
  /** Whether either party has blocked the other. */
  isBlockedEitherWay(a: string, b: string): Promise<boolean>;
  countFollowing(accountId: string): Promise<number>;
  listFollowing(
    accountId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<ProfilePage>;
  listFollowers(
    accountId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<ProfilePage>;
};

/**
 * One page of a list.
 *
 * `hasMore` is reported separately from the item count. Inferring it from
 * `items.length === limit` is wrong in the common case: a list whose size is an
 * exact multiple of the page size would advertise a next page that does not
 * exist, costing every client one empty round trip per traversal.
 */
export type ProfilePage = {
  readonly items: readonly ProfileSummary[];
  readonly hasMore: boolean;
};

/** What appears in a follower/following list. */
export type ProfileSummary = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
  readonly bio: string | null;
};

export type Clock = () => Date;
export type IdGenerator = () => string;
