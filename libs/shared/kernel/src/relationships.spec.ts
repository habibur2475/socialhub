import { describe, expect, it } from 'vitest';

import {
  canFollow,
  canFollowMore,
  canViewSection,
  PROFILE_SECTIONS,
  visibleSections,
  type ProfileSection,
  type ProfileVisibility,
} from './relationships.js';

const relation = (overrides: Partial<Parameters<typeof visibleSections>[0]> = {}) => ({
  profileVisibility: 'PUBLIC' as ProfileVisibility,
  isFollower: false,
  isBlocked: false,
  isSelf: false,
  ...overrides,
});

describe('profile visibility', () => {
  it('gives the owner every section', () => {
    const sections = visibleSections(relation({ isSelf: true, profileVisibility: 'PRIVATE' }));
    expect([...sections].sort()).toEqual([...PROFILE_SECTIONS].sort());
  });

  /**
   * The block check must defeat everything else, including self-view and a
   * pre-existing follow. This ordering is the rule most often implemented wrong.
   */
  it('exposes nothing when blocked, even to an existing follower', () => {
    expect(visibleSections(relation({ isBlocked: true, isFollower: true })).size).toBe(0);
    expect(visibleSections(relation({ isBlocked: true, isSelf: true })).size).toBe(0);
  });

  it('hides follower lists from strangers on a public profile', () => {
    const sections = visibleSections(relation({ profileVisibility: 'PUBLIC' }));
    // A public profile publishes posts, not a directory of its audience.
    expect(sections.has('FOLLOWERS')).toBe(false);
    expect(sections.has('FOLLOWING')).toBe(false);
    expect(sections.has('BIO')).toBe(true);
  });

  it('reveals follower lists to confirmed followers', () => {
    const sections = visibleSections(relation({ profileVisibility: 'PUBLIC', isFollower: true }));
    expect(sections.has('FOLLOWERS')).toBe(true);
    expect(sections.has('FOLLOWING')).toBe(true);
  });

  it('treats a followers-only profile like public for a follower', () => {
    const follower = visibleSections(
      relation({ profileVisibility: 'FOLLOWERS', isFollower: true }),
    );
    expect(follower.has('BIO')).toBe(true);
    expect(follower.has('FOLLOWERS')).toBe(true);
  });

  it('shows a stranger only identity and avatar on a followers-only profile', () => {
    const stranger = visibleSections(relation({ profileVisibility: 'FOLLOWERS' }));
    expect([...stranger].sort()).toEqual(['AVATAR', 'IDENTITY']);
  });

  it('shows even a follower only identity and avatar when private', () => {
    const follower = visibleSections(relation({ profileVisibility: 'PRIVATE', isFollower: true }));
    expect([...follower].sort()).toEqual(['AVATAR', 'IDENTITY']);
  });

  /** Every section must be reachable, so no branch forgot one. */
  it('accounts for every section in every branch', () => {
    const branches: readonly { visibility: ProfileVisibility; isFollower: boolean }[] = [
      { visibility: 'PUBLIC', isFollower: false },
      { visibility: 'PUBLIC', isFollower: true },
      { visibility: 'FOLLOWERS', isFollower: false },
      { visibility: 'FOLLOWERS', isFollower: true },
      { visibility: 'PRIVATE', isFollower: false },
      { visibility: 'PRIVATE', isFollower: true },
    ];

    for (const branch of branches) {
      const sections = visibleSections(
        relation({ profileVisibility: branch.visibility, isFollower: branch.isFollower }),
      );
      for (const section of sections) {
        expect(PROFILE_SECTIONS).toContain(section as ProfileSection);
      }
    }
  });

  it('narrows a single section consistently with the full set', () => {
    const rel = relation({ profileVisibility: 'PUBLIC' });
    expect(canViewSection(rel, 'BIO')).toBe(true);
    expect(canViewSection(rel, 'FOLLOWERS')).toBe(false);
  });
});

describe('follow rules', () => {
  it('refuses a self-follow', () => {
    expect(canFollow({ isSelf: true, isBlocked: false, targetFollowable: true })).toEqual({
      allowed: false,
      reason: 'SELF_FOLLOW',
    });
  });

  it('refuses a follow across a block', () => {
    expect(canFollow({ isSelf: false, isBlocked: true, targetFollowable: true })).toEqual({
      allowed: false,
      reason: 'BLOCKED',
    });
  });

  it('reports a block before reporting an unavailable target', () => {
    // A blocked caller must not learn whether the target still exists.
    expect(canFollow({ isSelf: false, isBlocked: true, targetFollowable: false })).toEqual({
      allowed: false,
      reason: 'BLOCKED',
    });
  });

  it('refuses a follow to a suspended or deleted target', () => {
    expect(canFollow({ isSelf: false, isBlocked: false, targetFollowable: false })).toEqual({
      allowed: false,
      reason: 'TARGET_UNAVAILABLE',
    });
  });

  it('allows an ordinary follow', () => {
    expect(canFollow({ isSelf: false, isBlocked: false, targetFollowable: true })).toEqual({
      allowed: true,
    });
  });

  it('stops following at the quota and reports the remainder', () => {
    expect(canFollowMore(10, 10)).toEqual({ allowed: false, reason: 'LIMIT_REACHED' });
    expect(canFollowMore(9, 10)).toEqual({ allowed: true, remaining: 1 });
  });
});
