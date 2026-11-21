/**
 * Profile service rules.
 *
 * These run against in-memory fakes, which is the point of the ports: the
 * visibility and block rules are business logic, and asserting them through a
 * database would make the suite slow and the failure harder to read.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ProfileVisibility } from '@socialhub/kernel';

import { ProfileService } from './profile.service.js';
import type { ProfileRecord, ProfileStore, RelationFacts, SocialGraphStore } from './ports.js';
import type { AuditSink } from '../../../common/audit/audit.port.js';

const OWNER = '0190f3c1-0000-7000-8000-000000000001';
const VIEWER = '0190f3c1-0000-7000-8000-000000000002';
const STRANGER = '0190f3c1-0000-7000-8000-000000000003';

const profile = (overrides: Partial<ProfileRecord> = {}): ProfileRecord => ({
  accountId: OWNER,
  username: 'ada',
  displayName: 'Ada Lovelace',
  bio: 'Mathematician',
  avatarKey: 'avatars/ada.png',
  bannerKey: 'banners/ada.png',
  visibility: 'PUBLIC',
  followerCount: 12,
  followingCount: 5,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const facts = (overrides: Partial<RelationFacts> = {}): RelationFacts => ({
  viewerFollowsTarget: false,
  blocked: false,
  followPending: false,
  ...overrides,
});

const createService = (
  options: { profile?: ProfileRecord | null; relation?: RelationFacts } = {},
) => {
  const record = options.profile === undefined ? profile() : options.profile;
  const relation = options.relation ?? facts();

  const update = vi.fn(async () => record);
  const store: ProfileStore = {
    findById: vi.fn(async () => record),
    findByUsername: vi.fn(async () => record),
    update,
    usernameTaken: vi.fn(async () => false),
    changeUsername: vi.fn(async () => record),
  };

  const follow = vi.fn(async () => {});
  const block = vi.fn(async () => {});
  const graph: SocialGraphStore = {
    relationBetween: vi.fn(async () => relation),
    follow,
    unfollow: vi.fn(async () => true),
    cancelFollowRequest: vi.fn(async () => true),
    acceptFollowRequest: vi.fn(async () => true),
    block,
    unblock: vi.fn(async () => true),
    isBlockedEitherWay: vi.fn(async () => relation.blocked),
    countFollowing: vi.fn(async () => 3),
    listFollowing: vi.fn(async () => ({ items: [], hasMore: false })),
    listFollowers: vi.fn(async () => ({ items: [], hasMore: false })),
  };

  const auditRecord = vi.fn(async () => {});
  const audit: AuditSink = { record: auditRecord };

  return { service: new ProfileService(store, graph, audit), store, graph, auditRecord };
};

const withVisibility = (visibility: ProfileVisibility) =>
  createService({ profile: profile({ visibility }) });

describe('profile visibility', () => {
  it('returns the full profile to its owner', async () => {
    const { service } = createService();
    const view = await service.getOwnProfile(OWNER);
    expect(view.bio).toBe('Mathematician');
    expect(view.followerCount).toBe(12);
    expect(view.isSelf).toBe(true);
  });

  it('shows a public profile in full to a stranger', async () => {
    const { service } = createService();
    const view = await service.getProfileByUsername(STRANGER, 'ada');
    expect(view.bio).toBe('Mathematician');
    expect(view.followerCount).toBe(12);
    expect(view.isSelf).toBe(false);
  });

  it('hides a followers-only profile from a stranger', async () => {
    const { service } = withVisibility('FOLLOWERS');
    const view = await service.getProfileByUsername(STRANGER, 'ada');
    // Redacted as null rather than omitted, so the client can still tell "hidden"
    // apart from "missing field".
    expect(view.bio).toBeNull();
    expect(view.followerCount).toBeNull();
    expect(view.followingCount).toBeNull();
    expect(view.displayName).toBe('Ada Lovelace');
  });

  it('reveals a followers-only profile to a confirmed follower', async () => {
    const { service } = createService({ relation: facts({ viewerFollowsTarget: true }) });
    const view = await service.getProfileByUsername(VIEWER, 'ada');
    expect(view.bio).toBe('Mathematician');
  });

  it('hides a private profile even from a follower', async () => {
    const { service } = createService({
      profile: profile({ visibility: 'PRIVATE' }),
      relation: facts({ viewerFollowsTarget: true }),
    });
    const view = await service.getProfileByUsername(VIEWER, 'ada');
    expect(view.bio).toBeNull();
    expect(view.followerCount).toBeNull();
  });

  /**
   * The block rule: the blocked party must not be able to tell a block from a
   * missing account, or the block becomes a notification.
   */
  it('reports a blocked profile as missing rather than forbidden', async () => {
    const { service } = createService({ relation: facts({ blocked: true }) });
    await expect(service.getProfileByUsername(VIEWER, 'ada')).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('following', () => {
  it('creates an accepted edge for a public target', async () => {
    const { service, graph } = createService();
    await expect(service.follow(VIEWER, OWNER)).resolves.toEqual({ following: true });
    expect(graph.follow).toHaveBeenCalledWith(VIEWER, OWNER, true);
  });

  it('creates a pending request for a private target', async () => {
    const { service, graph } = createService({ profile: profile({ visibility: 'PRIVATE' }) });
    await expect(service.follow(VIEWER, OWNER)).resolves.toEqual({ following: false });
    expect(graph.follow).toHaveBeenCalledWith(VIEWER, OWNER, false);
  });

  it('refuses a self-follow', async () => {
    const { service } = createService();
    await expect(service.follow(OWNER, OWNER)).rejects.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
  });

  it('reports a blocked target as missing, not forbidden', async () => {
    const { service, graph } = createService({ relation: facts({ blocked: true }) });
    await expect(service.follow(VIEWER, OWNER)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    // Nothing is written when the follow is refused.
    expect(graph.follow).not.toHaveBeenCalled();
  });

  it('refuses a follow beyond the quota', async () => {
    const { service, graph } = createService();
    vi.mocked(graph.countFollowing).mockResolvedValue(10_000);
    await expect(service.follow(VIEWER, OWNER)).rejects.toMatchObject({
      error: { code: 'RATE_LIMITED' },
    });
  });

  it('treats unfollowing an absent edge as success', async () => {
    const { service, graph } = createService();
    vi.mocked(graph.unfollow).mockResolvedValue(false);
    await expect(service.unfollow(VIEWER, OWNER)).resolves.toBeUndefined();
  });
});

describe('blocking', () => {
  it('writes the block and audits it', async () => {
    const { service, graph, auditRecord } = createService();
    await service.block(VIEWER, OWNER, 'harassment');

    expect(graph.block).toHaveBeenCalledWith(VIEWER, OWNER, 'harassment');
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'social.block.created', resourceId: OWNER }),
    );
  });

  it('records only whether a reason was given, not the reason itself', async () => {
    const { service, auditRecord } = createService();
    await service.block(VIEWER, OWNER, 'harassment');

    const event = auditRecord.mock.calls[0]?.[0] as unknown as {
      payload: { reasonProvided: boolean };
    };
    // The audit trail is permanent and readable by more people than the block
    // itself; the free-text reason stays out of it.
    expect(event.payload).toEqual({ reasonProvided: true });
  });

  it('refuses a self-block', async () => {
    const { service, graph } = createService();
    await expect(service.block(VIEWER, VIEWER, null)).rejects.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(graph.block).not.toHaveBeenCalled();
  });
});

describe('list visibility', () => {
  it('refuses a follower list to a stranger on a public profile', async () => {
    // A public profile publishes posts, not a directory of its audience.
    const { service } = createService();
    await expect(
      service.listFollowers(STRANGER, OWNER, { limit: 20, cursor: null }),
    ).rejects.toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('allows a follower list to a confirmed follower', async () => {
    const { service } = createService({ relation: facts({ viewerFollowsTarget: true }) });
    await expect(
      service.listFollowers(VIEWER, OWNER, { limit: 20, cursor: null }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });
});

describe('profile updates', () => {
  it('writes only the fields supplied', async () => {
    const { service, store } = createService();
    await service.updateOwnProfile(OWNER, { displayName: 'Ada' });

    expect(store.update).toHaveBeenCalledWith(OWNER, { displayName: 'Ada' });
  });

  it('distinguishes clearing a bio from leaving it alone', async () => {
    const { service, store } = createService();
    await service.updateOwnProfile(OWNER, { bio: null });

    // `undefined` means "unchanged"; `null` means "clear". Collapsing the two
    // would make it impossible to delete a bio.
    expect(store.update).toHaveBeenCalledWith(OWNER, { bio: null });
  });

  it('rejects a username that belongs to another account', async () => {
    const { service, store } = createService();
    vi.mocked(store.usernameTaken).mockResolvedValue(true);
    await expect(service.updateOwnProfile(OWNER, { username: 'taken' })).rejects.toMatchObject({
      error: { code: 'CONFLICT' },
    });
  });

  it('does not touch the profile table when only the username changes', async () => {
    const { service, store } = createService();
    await service.updateOwnProfile(OWNER, { username: 'ada_l' });

    expect(store.changeUsername).toHaveBeenCalledWith(OWNER, 'ada_l');
    expect(store.update).not.toHaveBeenCalled();
  });
});
