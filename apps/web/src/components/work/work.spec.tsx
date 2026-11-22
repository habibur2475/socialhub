/**
 * Work screens.
 *
 * What is testable without a browser: the vocabulary (no raw enum ever reaches a screen), the
 * deadline wording, and the one rule the page duplicates on purpose — whether a job is still
 * taking proposals. That duplication is checked against the same dates the server uses, because
 * the failure it prevents (a live bid form on a dead job) is exactly the kind of drift a test
 * can catch.
 */

import { describe, expect, it } from 'vitest';

import {
  contractStatusLabel,
  deadlineLabel,
  isOpenForProposals,
  jobActionLabel,
  jobStatusLabel,
  milestoneActionLabel,
  milestoneStatusLabel,
  priceLabel,
  proposalStatusLabel,
  workTone,
} from './vocabulary';

const NOW = new Date('2026-11-21T10:00:00.000Z');

describe('work vocabulary', () => {
  it('has a plain-language label for every job state', () => {
    for (const status of [
      'DRAFT',
      'OPEN',
      'ASSIGNED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
    ] as const) {
      expect(jobStatusLabel[status]).toEqual(expect.any(String));
      // The label is a sentence, not the enum: "OPEN" on a card is a bug this file prevents.
      expect(jobStatusLabel[status]).not.toBe(status);
    }
  });

  it('has a label for every milestone state and every action', () => {
    for (const status of ['PLANNED', 'FUNDED', 'SUBMITTED', 'RELEASED'] as const) {
      expect(milestoneStatusLabel[status]).toEqual(expect.any(String));
    }
    for (const action of ['FUND', 'SUBMIT', 'APPROVE'] as const) {
      expect(milestoneActionLabel[action]).toEqual(expect.any(String));
    }
    for (const action of ['AWARD', 'START', 'COMPLETE', 'CANCEL'] as const) {
      expect(jobActionLabel[action]).toEqual(expect.any(String));
    }
    for (const status of ['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN']) {
      expect(proposalStatusLabel[status]).toEqual(expect.any(String));
    }
    for (const status of ['ACTIVE', 'COMPLETED', 'CANCELLED', 'DISPUTED']) {
      expect(contractStatusLabel[status]).toEqual(expect.any(String));
    }
  });

  it('tones a settled contract differently from a disputed one', () => {
    expect(workTone('COMPLETED')).toBe(workTone('RELEASED'));
    expect(workTone('DISPUTED')).not.toBe(workTone('CANCELLED'));
    // An unknown status still renders a chip rather than crashing.
    expect(workTone('SOMETHING_NEW')).toEqual(expect.any(String));
  });

  it('formats a budget the way the rest of the app does', () => {
    expect(priceLabel(60_000, 'BDT')).toBe('৳ 600.00');
    expect(priceLabel(5_005, 'BDT')).toBe('৳ 50.05');
  });
});

describe('deadlines', () => {
  it('counts down in days while the deadline is near', () => {
    expect(deadlineLabel('2026-11-21T12:00:00.000Z', NOW)).toBe('Due today');
    expect(deadlineLabel('2026-11-22T12:00:00.000Z', NOW)).toBe('1 day left');
    expect(deadlineLabel('2026-11-24T10:00:00.000Z', NOW)).toBe('3 days left');
  });

  it('switches to a date once the countdown would be useless', () => {
    const far = deadlineLabel('2027-03-01T10:00:00.000Z', NOW);
    expect(far).not.toMatch(/days left/u);
    expect(far).toMatch(/2027/u);
  });

  it('stops calling a job open at the deadline, not at midnight after it', () => {
    expect(isOpenForProposals('OPEN', '2026-11-21T11:00:00.000Z', NOW)).toBe(true);
    expect(isOpenForProposals('OPEN', '2026-11-21T09:59:59.000Z', NOW)).toBe(false);
    // And a status that is not OPEN is closed regardless of the clock.
    expect(isOpenForProposals('ASSIGNED', '2027-01-01T00:00:00.000Z', NOW)).toBe(false);
    expect(deadlineLabel('2026-11-20T00:00:00.000Z', NOW)).toBe('Deadline passed');
  });
});
