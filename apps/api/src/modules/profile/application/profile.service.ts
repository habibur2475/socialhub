/**
 * Profile and social-graph use cases.
 *
 * Two rules govern this service:
 *
 *   1. **Redaction happens here, not in the controller.** A visibility decision
 *      made in the presentation layer is one that some future endpoint will
 *      forget. The read methods return a view that has already been reduced to
 *      what the viewer may see.
 *   2. **A block is invisible to the blocked party.** Being blocked must not be
 *      distinguishable from the account not existing, otherwise a block becomes a
 *      notification. Follow and profile reads across a block therefore return the
 *      same shape as a missing account.
 */

import { Injectable } from '@nestjs/common';
import {
  appError,
  canFollow,
  canFollowMore,
  type ProfileVisibility,
  visibleSections,
  type ViewerRelation,
} from '@socialhub/kernel';

import { DomainException } from '../../../common/filters/domain-exception.js';
import type { AuditSink } from '../../../common/audit/audit.port.js';
import type {
  ProfilePage,
  ProfileRecord,
  ProfileStore,
  ProfileSummary,
  RelationFacts,
  SocialGraphStore,
} from './ports.js';

/**
 * The wire shape of a profile.
 *
 * `null` on a redacted field is not the same as an absent one: the field is
 * present so the client can render a placeholder, and null so it cannot render
 * the value. Omission would make "hidden" and "empty" indistinguishable to the
 * UI, which leads to a hidden bio looking like a deliberate blank.
 */
export type ProfileView = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly avatarKey: string | null;
  readonly bannerKey: string | null;
  readonly followerCount: number | null;
  readonly followingCount: number | null;
  readonly createdAt: string;
  readonly isSelf: boolean;
  readonly isFollowing: boolean;
  readonly followPending: boolean;
  readonly isBlocked: boolean;
  readonly canFollow: boolean;
  readonly canMessage: boolean;
};

/**
 * Optional fields are typed `| undefined` explicitly: with
 * `exactOptionalPropertyTypes` an optional property is not the same as one that
 * may hold undefined, and the parsed request body is the latter.
 */
export type UpdateProfileInput = {
  readonly displayName?: string | undefined;
  readonly bio?: string | null | undefined;
  readonly visibility?: ProfileVisibility | undefined;
  readonly username?: string | undefined;
};

@Injectable()
export class ProfileService {
  public constructor(
    private readonly profiles: ProfileStore,
    private readonly graph: SocialGraphStore,
    private readonly audit: AuditSink,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The caller's own profile. Always complete: the owner sees everything. */
  public async getOwnProfile(accountId: string): Promise<ProfileView> {
    const profile = await this.profiles.findById(accountId);
    if (profile === null) throw new DomainException(appError('NOT_FOUND', 'Profile not found'));
    return this.present(profile, {
      relation: { viewerFollowsTarget: false, blocked: false, followPending: false },
      isSelf: true,
    });
  }

  public async getProfileByUsername(viewerId: string, username: string): Promise<ProfileView> {
    const profile = await this.profiles.findByUsername(username);
    // A missing profile and a blocked one are deliberately the same response.
    if (profile === null) throw new DomainException(appError('NOT_FOUND', 'Profile not found'));

    const isSelf = profile.accountId === viewerId;
    const relation: RelationFacts = isSelf
      ? { viewerFollowsTarget: false, blocked: false, followPending: false }
      : await this.graph.relationBetween(viewerId, profile.accountId);

    if (relation.blocked && !isSelf)
      throw new DomainException(appError('NOT_FOUND', 'Profile not found'));

    return this.present(profile, { relation, isSelf });
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  public async updateOwnProfile(
    accountId: string,
    input: UpdateProfileInput,
  ): Promise<ProfileView> {
    // The username is unique platform-wide and lives behind its own index, so it
    // is checked and written separately from the freely editable fields.
    if (input.username !== undefined) {
      if (await this.profiles.usernameTaken(input.username, accountId)) {
        throw new DomainException(appError('CONFLICT', 'That username is already taken'));
      }
      await this.profiles.changeUsername(accountId, input.username);
    }

    const changed =
      input.displayName !== undefined || input.bio !== undefined || input.visibility !== undefined;

    if (changed) {
      await this.profiles.update(accountId, {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.bio === undefined ? {} : { bio: input.bio }),
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      });
    }

    return this.getOwnProfile(accountId);
  }

  // -------------------------------------------------------------------------
  // Social graph
  // -------------------------------------------------------------------------

  public async follow(followerId: string, followeeId: string): Promise<{ following: boolean }> {
    const target = await this.profiles.findById(followeeId);
    if (target === null) throw new DomainException(appError('NOT_FOUND', 'Profile not found'));

    const relation = await this.graph.relationBetween(followerId, followeeId);

    const decision = canFollow({
      isSelf: followerId === followeeId,
      isBlocked: relation.blocked,
      targetFollowable: true,
    });

    if (!decision.allowed) {
      // A blocked party receives NOT_FOUND, not FORBIDDEN: telling them they were
      // blocked would defeat the purpose of the block.
      if (decision.reason === 'SELF_FOLLOW') {
        throw new DomainException(appError('VALIDATION_FAILED', 'You cannot follow yourself'));
      }
      throw new DomainException(appError('NOT_FOUND', 'Profile not found'));
    }

    const quota = canFollowMore(await this.graph.countFollowing(followerId));
    if (!quota.allowed) {
      throw new DomainException(
        appError('RATE_LIMITED', 'You have reached the maximum number of accounts you can follow'),
      );
    }

    // A private target receives a pending request; a public one is an edge
    // immediately. Following is idempotent, so a repeat call is not an error.
    const accepted = target.visibility === 'PUBLIC';
    await this.graph.follow(followerId, followeeId, accepted);

    return { following: accepted };
  }

  public async unfollow(followerId: string, followeeId: string): Promise<void> {
    const removed = await this.graph.unfollow(followerId, followeeId);
    if (!removed) {
      // Idempotent by design: unfollowing something you do not follow is what the
      // caller wanted to be true, so it succeeds without a write.
      return;
    }
  }

  public async acceptFollowRequest(ownerId: string, requesterId: string): Promise<void> {
    const relation = await this.graph.relationBetween(ownerId, requesterId);
    if (relation.blocked) throw new DomainException(appError('NOT_FOUND', 'Profile not found'));

    const accepted = await this.graph.acceptFollowRequest(requesterId, ownerId);
    if (!accepted)
      throw new DomainException(
        appError('NOT_FOUND', 'No pending follow request from that account'),
      );
  }

  public async block(blockerId: string, blockedId: string, reason: string | null): Promise<void> {
    if (blockerId === blockedId) {
      throw new DomainException(appError('VALIDATION_FAILED', 'You cannot block yourself'));
    }

    await this.graph.block(blockerId, blockedId, reason);

    // Blocking is a consequential action on another account, so it is audited
    // even though it is a normal user capability. The reason is recorded because
    // moderation needs it; the pair alone does not explain the decision.
    await this.audit.record({
      action: 'social.block.created',
      actorId: blockerId,
      actorType: 'USER',
      resourceType: 'account',
      resourceId: blockedId,
      outcome: 'SUCCESS',
      ipHash: null,
      userAgent: null,
      traceId: null,
      payload: { reasonProvided: reason !== null },
    });
  }

  public async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.graph.unblock(blockerId, blockedId);
  }

  public async listFollowing(
    viewerId: string,
    accountId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<ProfileList> {
    await this.assertSectionVisible(viewerId, accountId, 'FOLLOWING');
    return toList(await this.graph.listFollowing(accountId, page));
  }

  public async listFollowers(
    viewerId: string,
    accountId: string,
    page: { limit: number; cursor: string | null },
  ): Promise<ProfileList> {
    await this.assertSectionVisible(viewerId, accountId, 'FOLLOWERS');
    return toList(await this.graph.listFollowers(accountId, page));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Gates a list endpoint on the same rules as the profile body.
   *
   * The follower list is the most sensitive part of a profile: it is the part
   * that reveals *relationships*, and therefore the part that exposes people who
   * never chose to be visible. It is therefore gated identically to the counts,
   * through the one kernel rule set.
   */
  private async assertSectionVisible(
    viewerId: string,
    accountId: string,
    section: 'FOLLOWERS' | 'FOLLOWING',
  ): Promise<void> {
    const profile = await this.profiles.findById(accountId);
    if (profile === null) throw new DomainException(appError('NOT_FOUND', 'Profile not found'));

    const isSelf = viewerId === accountId;
    const relation = isSelf
      ? { viewerFollowsTarget: false, blocked: false, followPending: false }
      : await this.graph.relationBetween(viewerId, accountId);

    const viewerRelation: ViewerRelation = {
      profileVisibility: profile.visibility,
      isFollower: relation.viewerFollowsTarget,
      isBlocked: relation.blocked,
      isSelf,
    };

    if (!visibleSections(viewerRelation).has(section)) {
      throw new DomainException(appError('FORBIDDEN', 'This list is not visible to you'));
    }
  }

  private present(
    profile: ProfileRecord,
    context: { relation: RelationFacts; isSelf: boolean },
  ): ProfileView {
    const { relation, isSelf } = context;
    const visibility = visibleSections({
      profileVisibility: profile.visibility,
      isFollower: relation.viewerFollowsTarget,
      isBlocked: relation.blocked,
      isSelf,
    });

    const canSeeBio = visibility.has('BIO');
    const canSeeCounts = visibility.has('COUNTS');

    const canFollowTarget = canFollow({
      isSelf,
      isBlocked: relation.blocked,
      targetFollowable: true,
    }).allowed;

    return {
      accountId: profile.accountId,
      username: profile.username,
      displayName: profile.displayName,
      bio: canSeeBio ? profile.bio : null,
      avatarKey: visibility.has('AVATAR') ? profile.avatarKey : null,
      bannerKey: canSeeBio ? profile.bannerKey : null,
      followerCount: canSeeCounts ? profile.followerCount : null,
      followingCount: canSeeCounts ? profile.followingCount : null,
      createdAt: profile.createdAt.toISOString(),
      isSelf,
      isFollowing: relation.viewerFollowsTarget,
      followPending: relation.followPending,
      isBlocked: isSelf ? false : relation.blocked,
      canFollow: canFollowTarget && !relation.viewerFollowsTarget && !relation.followPending,
      // Direct messaging is a separate consent decision and is out of scope for
      // this release; reporting false keeps the contract honest rather than
      // promising a capability that does not exist.
      canMessage: false,
    };
  }
}

export type ProfileList = {
  readonly items: readonly ProfileSummary[];
  readonly nextCursor: string | null;
};

/**
 * Keyset pagination.
 *
 * Offset pagination on a follower list is wrong under concurrent writes: a new
 * follower shifts every subsequent page and the reader sees duplicates. The
 * cursor is the last account id seen, which is both the sort key and the
 * tie-breaker, so pages cannot overlap or skip.
 */
const toList = (page: ProfilePage): ProfileList => ({
  items: page.items,
  nextCursor: page.hasMore ? (page.items[page.items.length - 1]?.accountId ?? null) : null,
});
