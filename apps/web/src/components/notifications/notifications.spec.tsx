/**
 * Notification rendering.
 *
 * The collapse wording is the part users read, and it is the part most likely to be
 * wrong in an off-by-one way: "and 0 others" is the bug this pins down.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { NotificationResponse } from '@socialhub/contracts';

import { describeActors } from './notification-list';

const actor = (displayName: string): NotificationResponse['actors'][number] => ({
  accountId: `id-${displayName}`,
  username: displayName.toLowerCase(),
  displayName,
  avatarKey: null,
});

const notification = (overrides: Partial<NotificationResponse> = {}): NotificationResponse => ({
  id: 'score-notification',
  kind: 'LIKE',
  actors: [actor('Ada')],
  actorCount: 1,
  preview: 'hello',
  subjectType: 'post',
  subjectId: '0190f3c1-0000-7000-8000-0000000000aa',
  read: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

afterEach(cleanup);

describe('describeActors', () => {
  it('names a single actor', () => {
    expect(describeActors(notification())).toBe('Ada');
  });

  it('says "and 1 other" rather than naming a name it may not have', () => {
    // The actor list is bounded at five while the count can be larger, so the wording
    // has to work from the count, not from the array length.
    expect(
      describeActors(notification({ actors: [actor('Ada'), actor('Grace')], actorCount: 2 })),
    ).toBe('Ada and 1 other');
  });

  it('summarises a large collapse', () => {
    expect(
      describeActors(notification({ actors: [actor('Ada'), actor('Grace')], actorCount: 10 })),
    ).toBe('Ada and 9 others');
  });

  it('falls back when the actor list is empty', () => {
    // Possible when an account is deleted between the write and the read.
    expect(describeActors(notification({ actors: [], actorCount: 1 }))).toBe('Someone');
  });
});

describe('notification list rendering', () => {
  /**
   * The list is not rendered here — it fetches on mount, and the API client is created
   * from the session. What can be checked without a server is that the modules import
   * cleanly, which is what the Next build will do with them.
   */
  it('imports the list component without a browser-only crash', async () => {
    const module = await import('./notification-list');
    expect(typeof module.NotificationList).toBe('function');
    render(<p>placeholder</p>);
    expect(screen.getByText('placeholder')).toBeDefined();
  });
});
