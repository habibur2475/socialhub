/**
 * Work policy.
 *
 * The tests that matter are the ones a job marketplace gets wrong quietly: a proposal accepted
 * while a dozen others stay open, a milestone plan that does not add up to the budget, and a
 * release that pays out after a dispute froze the escrow.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_BUDGET_MINOR,
  MAX_DEADLINE_DAYS,
  MIN_BUDGET_MINOR,
  WORK_FEE_BPS,
  awardProposal,
  canMoveJob,
  canMoveMilestone,
  checkJobForPublishing,
  checkMilestonePlan,
  checkProposal,
  checkRelease,
  computeReleaseSplit,
  decideJobMove,
  heldOf,
  resolveDispute,
  type Job,
  type MilestoneStatus,
  type Proposal,
} from './work.js';

const NOW = new Date('2026-11-22T00:00:00Z');
const inDays = (days: number): Date => new Date(NOW.getTime() + days * 86_400_000);

const job = (overrides: Partial<Job> = {}): Job => ({
  id: 'j1',
  clientId: 'client',
  status: 'OPEN',
  budget: { currency: 'BDT', minor: 100_000 },
  deadline: inDays(30),
  ...overrides,
});

const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: 'p1',
  jobId: 'j1',
  freelancerId: 'freelancer',
  status: 'PENDING',
  bid: { currency: 'BDT', minor: 90_000 },
  deliveryDays: 14,
  ...overrides,
});

describe('publishing a job', () => {
  it('accepts a sane budget and a deadline inside the horizon', () => {
    expect(
      checkJobForPublishing(
        { budgetMinor: MIN_BUDGET_MINOR, deadline: inDays(7), title: 'Build a thing' },
        { now: NOW },
      ),
    ).toBeNull();
  });

  it('refuses a budget below the minimum and above the ceiling, naming the number', () => {
    expect(
      checkJobForPublishing({ budgetMinor: 4_999, deadline: inDays(7), title: 'x' }, { now: NOW }),
    ).toEqual({ code: 'BUDGET_TOO_LOW', minor: 4_999 });

    expect(
      checkJobForPublishing(
        { budgetMinor: MAX_BUDGET_MINOR + 1, deadline: inDays(7), title: 'x' },
        { now: NOW },
      ),
    ).toEqual({ code: 'BUDGET_TOO_HIGH', minor: MAX_BUDGET_MINOR + 1 });
  });

  it('refuses a deadline that has passed or is more than a year away', () => {
    expect(
      checkJobForPublishing(
        { budgetMinor: 10_000, deadline: inDays(-1), title: 'x' },
        { now: NOW },
      ),
    ).toEqual({ code: 'DEADLINE_IN_PAST' });

    expect(
      checkJobForPublishing(
        { budgetMinor: 10_000, deadline: inDays(MAX_DEADLINE_DAYS + 1), title: 'x' },
        { now: NOW },
      ),
    ).toEqual({ code: 'DEADLINE_TOO_FAR' });
  });
});

describe('the job state machine', () => {
  it('only lets the client publish, award and complete', () => {
    expect(canMoveJob('DRAFT', 'OPEN')).toBe(true);
    expect(canMoveJob('OPEN', 'ASSIGNED')).toBe(true);
    expect(canMoveJob('COMPLETED', 'OPEN')).toBe(false);
    expect(canMoveJob('CANCELLED', 'OPEN')).toBe(false);
  });

  it('lets only the freelancer start work', () => {
    const start = decideJobMove('IN_PROGRESS', {
      job: job({ status: 'ASSIGNED' }),
      actor: 'FREELANCER',
      actorId: 'freelancer',
      freelancerId: 'freelancer',
      blocked: false,
    });
    expect(start.ok).toBe(true);

    // The client cannot claim their own job is in progress.
    const byClient = decideJobMove('IN_PROGRESS', {
      job: job({ status: 'ASSIGNED' }),
      actor: 'CLIENT',
      actorId: 'client',
      freelancerId: 'freelancer',
      blocked: false,
    });
    expect(byClient.ok).toBe(false);
  });

  it('refuses a move the state does not allow, saying which two states', () => {
    const result = decideJobMove('COMPLETED', {
      job: job({ status: 'OPEN' }),
      actor: 'CLIENT',
      actorId: 'client',
      freelancerId: null,
      blocked: false,
    });
    expect(result).toEqual({
      ok: false,
      error: { code: 'INVALID_TRANSITION', from: 'OPEN', to: 'COMPLETED' },
    });
  });

  it('refuses someone else’s job even with the right role', () => {
    const result = decideJobMove('ASSIGNED', {
      job: job({ status: 'OPEN' }),
      actor: 'CLIENT',
      actorId: 'a-different-client',
      freelancerId: null,
      blocked: false,
    });
    expect(result).toEqual({ ok: false, error: { code: 'NOT_YOUR_JOB' } });
  });

  it('lets a block outrank every other reason', () => {
    const result = decideJobMove('ASSIGNED', {
      job: job({ status: 'OPEN' }),
      actor: 'CLIENT',
      actorId: 'client',
      freelancerId: null,
      blocked: true,
    });
    expect(result).toEqual({ ok: false, error: { code: 'BLOCKED' } });
  });
});

describe('proposals', () => {
  it('refuses a freelancer applying to their own job', () => {
    expect(
      checkProposal({
        job: job({ clientId: 'same' }),
        clientId: 'same',
        freelancerId: 'same',
        bidMinor: 50_000,
        existing: [],
        blocked: false,
      }),
    ).toEqual({ code: 'OWN_JOB' });
  });

  it('refuses a bid above the advertised budget, which the client cannot answer', () => {
    expect(
      checkProposal({
        job: job(),
        clientId: 'client',
        freelancerId: 'freelancer',
        bidMinor: 150_000,
        existing: [],
        blocked: false,
      }),
    ).toEqual({ code: 'BID_EXCEEDS_BUDGET', bid: 150_000, budget: 100_000 });
  });

  it('allows a bid below the budget — that is a negotiation, not an error', () => {
    expect(
      checkProposal({
        job: job(),
        clientId: 'client',
        freelancerId: 'freelancer',
        bidMinor: 60_000,
        existing: [],
        blocked: false,
      }),
    ).toBeNull();
  });

  it('refuses a second pending proposal, but not to replace a withdrawn one', () => {
    const base = {
      job: job(),
      clientId: 'client',
      freelancerId: 'freelancer',
      bidMinor: 60_000,
      blocked: false,
    };

    expect(checkProposal({ ...base, existing: [proposal()] })).toEqual({
      code: 'ALREADY_APPLIED',
    });

    expect(checkProposal({ ...base, existing: [proposal({ status: 'WITHDRAWN' })] })).toBeNull();
  });

  it('refuses a proposal against a job that is no longer open', () => {
    for (const status of ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DRAFT'] as const) {
      expect(
        checkProposal({
          job: job({ status }),
          clientId: 'client',
          freelancerId: 'freelancer',
          bidMinor: 10_000,
          existing: [],
          blocked: false,
        }),
      ).toEqual({ code: 'JOB_NOT_OPEN', status });
    }
  });
});

describe('awarding', () => {
  it('accepts one proposal and closes every other pending one', () => {
    const result = awardProposal(
      [
        proposal({ id: 'p1', freelancerId: 'a' }),
        proposal({ id: 'p2', freelancerId: 'b' }),
        proposal({ id: 'p3', freelancerId: 'c', status: 'WITHDRAWN' }),
      ],
      'p1',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.accepted.id).toBe('p1');
    expect(result.value.rejected.map((entry) => entry.id)).toEqual(['p2']);
    // The withdrawn proposal is left alone: it was already closed by its author.
    expect(result.value.rejected.some((entry) => entry.id === 'p3')).toBe(false);
  });

  it('sets the contract budget from the bid, not the advertised budget', () => {
    const result = awardProposal([proposal({ bid: { currency: 'BDT', minor: 70_000 } })], 'p1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.budget.minor).toBe(70_000);
  });

  it('refuses to award a proposal that is not pending', () => {
    expect(awardProposal([proposal({ status: 'REJECTED' })], 'p1')).toEqual({
      ok: false,
      error: { code: 'PROPOSAL_NOT_PENDING' },
    });
  });

  it('refuses to award a proposal that does not exist', () => {
    expect(awardProposal([proposal()], 'nope')).toEqual({
      ok: false,
      error: { code: 'NO_PROPOSALS' },
    });
  });
});

describe('milestones', () => {
  it('accepts a plan that adds up to the budget, to the paisa', () => {
    expect(
      checkMilestonePlan(
        [{ amountMinor: 33_333 }, { amountMinor: 33_333 }, { amountMinor: 33_334 }],
        {
          currency: 'BDT',
          minor: 100_000,
        },
      ),
    ).toBeNull();
  });

  it('refuses a plan that is one paisa short, and says both numbers', () => {
    expect(
      checkMilestonePlan(
        [{ amountMinor: 33_333 }, { amountMinor: 33_333 }, { amountMinor: 33_333 }],
        {
          currency: 'BDT',
          minor: 100_000,
        },
      ),
    ).toEqual({ code: 'MILESTONES_DO_NOT_ADD_UP', expected: 100_000, actual: 99_999 });
  });

  it('refuses an empty plan and a milestone of nothing', () => {
    expect(checkMilestonePlan([], { currency: 'BDT', minor: 1_000 })).not.toBeNull();
    expect(
      checkMilestonePlan([{ amountMinor: 0 }, { amountMinor: 1_000 }], {
        currency: 'BDT',
        minor: 1_000,
      }),
    ).not.toBeNull();
  });

  it('only moves a milestone forwards', () => {
    const legal: readonly (readonly [MilestoneStatus, MilestoneStatus])[] = [
      ['PLANNED', 'FUNDED'],
      ['FUNDED', 'SUBMITTED'],
      ['SUBMITTED', 'RELEASED'],
    ];
    for (const [from, to] of legal) expect(canMoveMilestone(from, to)).toBe(true);

    // Delivered work cannot be returned to a queue; a client disputes instead.
    expect(canMoveMilestone('SUBMITTED', 'FUNDED')).toBe(false);
    expect(canMoveMilestone('RELEASED', 'SUBMITTED')).toBe(false);
  });
});

describe('escrow', () => {
  const funded = {
    funded: { currency: 'BDT' as const, minor: 100_000 },
    released: { currency: 'BDT' as const, minor: 40_000 },
    disputeOpen: false,
  };

  it('reports what is still held rather than storing it', () => {
    expect(heldOf(funded).minor).toBe(60_000);
  });

  it('refuses a release while a dispute is open', () => {
    expect(
      checkRelease({
        ...funded,
        disputeOpen: true,
        amount: { currency: 'BDT', minor: 1_000 },
        budget: { currency: 'BDT', minor: 100_000 },
      }),
    ).toEqual({ code: 'DISPUTE_OPEN' });
  });

  it('refuses a release larger than the escrow holds', () => {
    expect(
      checkRelease({
        ...funded,
        amount: { currency: 'BDT', minor: 70_000 },
        budget: { currency: 'BDT', minor: 100_000 },
      }),
    ).toEqual({ code: 'MILESTONES_DO_NOT_ADD_UP', expected: 60_000, actual: 70_000 });
  });

  it('refuses a release when nothing is left, which is a fact rather than an error', () => {
    expect(
      checkRelease({
        ...funded,
        released: { currency: 'BDT', minor: 100_000 },
        amount: { currency: 'BDT', minor: 1 },
        budget: { currency: 'BDT', minor: 100_000 },
      }),
    ).toEqual({ code: 'ALREADY_RELEASED' });
  });

  it('refuses a release in another currency', () => {
    expect(
      checkRelease({
        ...funded,
        amount: { currency: 'USD', minor: 1_000 },
        budget: { currency: 'BDT', minor: 100_000 },
      }),
    ).toEqual({ code: 'CURRENCY_MISMATCH' });
  });
});

describe('the platform fee', () => {
  it('conserves every minor unit: fee + net = gross', () => {
    for (const minor of [1, 7, 99, 1_000, 33_333, 100_000, 499_999]) {
      const split = computeReleaseSplit({ currency: 'BDT', minor });
      expect(split.ok).toBe(true);
      if (!split.ok) return;
      expect(split.value.fee.minor + split.value.toFreelancer.minor).toBe(minor);
    }
  });

  it('takes the fee from the freelancer’s side, not on top of the budget', () => {
    const split = computeReleaseSplit({ currency: 'BDT', minor: 100_000 });
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    // 5% of 100,000; the client funded 100,000 and pays 100,000.
    expect(split.value.fee.minor).toBe(5_000);
    expect(split.value.toFreelancer.minor).toBe(95_000);
    expect(WORK_FEE_BPS).toBe(500);
  });

  it('refuses a fee rate outside the allowed range', () => {
    expect(computeReleaseSplit({ currency: 'BDT', minor: 100 }, 5_001)).toEqual({
      ok: false,
      error: { code: 'FEE_OUT_OF_RANGE', feeBps: 5_001 },
    });
  });
});

describe('disputes', () => {
  const held = { currency: 'BDT' as const, minor: 60_000 };

  it('pays everything to the freelancer or refunds everything to the client', () => {
    const toFreelancer = resolveDispute(held, 'RELEASED_TO_FREELANCER');
    expect(toFreelancer.ok && toFreelancer.value.toClient.minor).toBe(0);

    const toClient = resolveDispute(held, 'REFUNDED_TO_CLIENT');
    expect(toClient.ok && toClient.value.toFreelancer.minor).toBe(0);
    expect(toClient.ok && toClient.value.toClient.minor).toBe(60_000);
  });

  it('always places the whole amount, so a resolution cannot lose a paisa', () => {
    for (const split of [0, 1, 29_999, 60_000]) {
      const result = resolveDispute(held, 'REFUNDED_TO_CLIENT', split);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.toFreelancer.minor + result.value.toClient.minor).toBe(held.minor);
    }
  });

  it('refuses a split that would pay out more than is held', () => {
    expect(resolveDispute(held, 'REFUNDED_TO_CLIENT', 60_001)).toEqual({
      ok: false,
      error: { code: 'MILESTONES_DO_NOT_ADD_UP', expected: 60_000, actual: 60_001 },
    });
  });
});
