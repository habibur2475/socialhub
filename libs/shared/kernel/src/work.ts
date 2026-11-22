/**
 * Work — the freelance job marketplace.
 *
 * A job board is not a shop. A shop sells a thing that already exists; a job sells work that
 * has to be produced, and the money is held in the middle until both sides agree it was. That
 * single difference produces every rule here:
 *
 *   1. **A contract is formed by two acceptances, not one click.** Freelancers apply; exactly
 *      one application becomes the contract; every other application closes at the same
 *      instant. A job that stays open after being awarded is a job that collects bids it can
 *      never honour.
 *   2. **A client cannot hire themselves, and cannot hire a blocked account.** The check is in
 *      the same place as the state machine so a route cannot skip it.
 *   3. **Money is held, never sent early.** A funded contract holds the budget. Each milestone
 *      releases on approval, and releasing more than was funded is refused by arithmetic
 *      rather than by a policy paragraph.
 *   4. **A dispute freezes the money, it does not move it.** Neither party can release after a
 *      dispute is opened; only the platform can resolve it, and the resolution says where every
 *      minor unit went.
 *
 * Everything here is pure: no clock, no database, no ids. The service supplies those, which is
 * what makes the state machine testable and the database able to enforce the same table.
 */

import { type Result, fail, ok } from './result.js';
import type { Money } from './money.js';

/* ------------------------------------------------------------------------------ the job */

export type JobStatus = 'DRAFT' | 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export const JOB_STATUSES: readonly JobStatus[] = [
  'DRAFT',
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
];

/** What the board shows, in the words a client would use. */
export const JOB_STATUS_LABELS: Readonly<Record<JobStatus, string>> = {
  DRAFT: 'Not published',
  OPEN: 'Accepting proposals',
  ASSIGNED: 'Freelancer chosen',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/**
 * The legal moves, and who may make each one.
 *
 * `DRAFT → OPEN` is the client publishing. `OPEN → ASSIGNED` happens when a proposal is
 * accepted and is the only way out of `OPEN` that keeps the job alive. `ASSIGNED →
 * IN_PROGRESS` is the freelancer starting work — deliberately a separate step from being
 * hired, because "hired but never started" is a state a client needs to be able to see and
 * cancel without pretending nothing happened.
 */
const JOB_MOVES: Readonly<Record<JobStatus, Partial<Record<JobStatus, JobActor>>>> = {
  DRAFT: { OPEN: 'CLIENT', CANCELLED: 'CLIENT' },
  OPEN: { ASSIGNED: 'CLIENT', CANCELLED: 'CLIENT' },
  ASSIGNED: { IN_PROGRESS: 'FREELANCER', CANCELLED: 'CLIENT' },
  IN_PROGRESS: { COMPLETED: 'CLIENT', CANCELLED: 'PLATFORM' },
  COMPLETED: {},
  CANCELLED: {},
};

export type JobActor = 'CLIENT' | 'FREELANCER' | 'PLATFORM';

export const canMoveJob = (from: JobStatus, to: JobStatus): boolean =>
  JOB_MOVES[from][to] !== undefined;

export type JobRefusal =
  | { readonly code: 'INVALID_TRANSITION'; readonly from: JobStatus; readonly to: JobStatus }
  | { readonly code: 'NOT_YOUR_JOB' }
  | { readonly code: 'OWN_JOB' }
  | { readonly code: 'JOB_NOT_OPEN'; readonly status: JobStatus }
  | { readonly code: 'BUDGET_TOO_LOW'; readonly minor: number }
  | { readonly code: 'BUDGET_TOO_HIGH'; readonly minor: number }
  | { readonly code: 'CURRENCY_MISMATCH' }
  | { readonly code: 'DEADLINE_IN_PAST' }
  | { readonly code: 'DEADLINE_TOO_FAR' }
  | { readonly code: 'NO_PROPOSALS' }
  | { readonly code: 'ALREADY_APPLIED' }
  | { readonly code: 'OWN_PROPOSAL' }
  | { readonly code: 'BID_EXCEEDS_BUDGET'; readonly bid: number; readonly budget: number }
  | { readonly code: 'PROPOSAL_NOT_PENDING' }
  | {
      readonly code: 'MILESTONES_DO_NOT_ADD_UP';
      readonly expected: number;
      readonly actual: number;
    }
  | { readonly code: 'NOT_FUNDED' }
  | { readonly code: 'ALREADY_RELEASED' }
  | { readonly code: 'DISPUTE_OPEN' }
  | { readonly code: 'NO_DISPUTE' }
  | { readonly code: 'BLOCKED' };

/** A job budget below this is a typo, not an offer. */
export const MIN_BUDGET_MINOR = 5_000;
/** The ceiling keeps every derived total inside a bigint column and a sane page. */
export const MAX_BUDGET_MINOR = 500_000_000;
export const MIN_TITLE_LENGTH = 8;
export const MAX_TITLE_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 8_000;
/** The longest a client may advertise work for: a year. Beyond that the budget is fiction. */
export const MAX_DEADLINE_DAYS = 365;
export const MAX_MILESTONES = 10;
export const MAX_PROPOSAL_LENGTH = 4_000;

export type Job = {
  readonly id: string;
  readonly clientId: string;
  readonly status: JobStatus;
  readonly budget: Money;
  /** The moment the work is due. Compared against a caller-supplied clock, never `Date.now`. */
  readonly deadline: Date;
};

export type JobCheckContext = {
  readonly now: Date;
};

/**
 * Whether a job may be published as described.
 *
 * The budget and deadline checks are here rather than in the schema alone because the refusal
 * has to say *which* number is wrong; a CHECK constraint can only say "no".
 */
export const checkJobForPublishing = (
  input: { readonly budgetMinor: number; readonly deadline: Date; readonly title: string },
  context: JobCheckContext,
): JobRefusal | null => {
  if (input.budgetMinor < MIN_BUDGET_MINOR)
    return { code: 'BUDGET_TOO_LOW', minor: input.budgetMinor };
  if (input.budgetMinor > MAX_BUDGET_MINOR)
    return { code: 'BUDGET_TOO_HIGH', minor: input.budgetMinor };
  if (input.deadline.getTime() <= context.now.getTime()) return { code: 'DEADLINE_IN_PAST' };

  const horizon = context.now.getTime() + MAX_DEADLINE_DAYS * 86_400_000;
  if (input.deadline.getTime() > horizon) return { code: 'DEADLINE_TOO_FAR' };

  return null;
};

export type JobMoveContext = {
  readonly job: Job;
  readonly actor: JobActor;
  readonly actorId: string;
  /** Set when the freelancer is known — a job in `OPEN` has none yet. */
  readonly freelancerId: string | null;
  readonly blocked: boolean;
};

/**
 * Decides a job move.
 *
 * The order of the checks is the order of the reasons a person would care about: a block
 * outranks everything, then ownership, then whether this state allows the move at all, then
 * whether *this* caller is the actor that state expects.
 */
export const decideJobMove = (
  to: JobStatus,
  context: JobMoveContext,
): Result<{ readonly to: JobStatus }, JobRefusal> => {
  const { job, actor, actorId, freelancerId, blocked } = context;

  if (blocked) return fail({ code: 'BLOCKED' });

  const expected = JOB_MOVES[job.status][to];
  if (expected === undefined) return fail({ code: 'INVALID_TRANSITION', from: job.status, to });
  if (expected !== actor) return fail({ code: 'INVALID_TRANSITION', from: job.status, to });

  if (actor === 'CLIENT' && job.clientId !== actorId) return fail({ code: 'NOT_YOUR_JOB' });
  if (actor === 'FREELANCER' && freelancerId !== actorId) return fail({ code: 'NOT_YOUR_JOB' });

  return ok({ to });
};

/* ------------------------------------------------------------------------- the proposal */

export type ProposalStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN';

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
];

export type Proposal = {
  readonly id: string;
  readonly jobId: string;
  readonly freelancerId: string;
  readonly status: ProposalStatus;
  /** What the freelancer asks for, which may be less than the budget but never more. */
  readonly bid: Money;
  /** How many days they need, from acceptance. */
  readonly deliveryDays: number;
};

export type ProposalCheck = {
  readonly job: Job;
  readonly clientId: string;
  readonly freelancerId: string;
  readonly bidMinor: number;
  readonly existing: readonly Proposal[];
  readonly blocked: boolean;
};

export const MIN_DELIVERY_DAYS = 1;
export const MAX_DELIVERY_DAYS = 365;

/**
 * Whether a freelancer may propose.
 *
 * The bid ceiling is the interesting rule: a proposal above the advertised budget is refused
 * rather than recorded, because a client who budgets 5,000 and receives a 9,000 bid has been
 * shown a number they cannot act on. Asking for *less* is allowed — that is a negotiation the
 * client can accept in one click.
 */
export const checkProposal = (input: ProposalCheck): JobRefusal | null => {
  const { job, clientId, freelancerId, bidMinor, existing, blocked } = input;

  if (blocked) return { code: 'BLOCKED' };
  if (job.clientId === freelancerId) return { code: 'OWN_JOB' };
  if (job.status !== 'OPEN') return { code: 'JOB_NOT_OPEN', status: job.status };

  if (bidMinor <= 0) return { code: 'BUDGET_TOO_LOW', minor: bidMinor };
  if (bidMinor > job.budget.minor) {
    return { code: 'BID_EXCEEDS_BUDGET', bid: bidMinor, budget: job.budget.minor };
  }

  // One proposal per freelancer per job, and a withdrawn one may be replaced.
  const mine = existing.filter(
    (proposal) => proposal.freelancerId === freelancerId && proposal.jobId === job.id,
  );
  if (mine.some((proposal) => proposal.status === 'PENDING' || proposal.status === 'ACCEPTED')) {
    return { code: 'ALREADY_APPLIED' };
  }

  // `clientId` is read for the ownership check the caller does separately; referenced here so
  // the parameter is not dead weight in the signature.
  void clientId;

  return null;
};

export type AwardResult = {
  readonly accepted: Proposal;
  readonly rejected: readonly Proposal[];
  /** The contract budget is the *bid*, not the advertised budget. */
  readonly budget: Money;
};

/**
 * Accepting one proposal, and closing the rest.
 *
 * Returning the rejected proposals rather than letting the caller loop means a caller cannot
 * accept one and forget the others — the failure mode that leaves a job awarded but still
 * showing a dozen hopeful proposals.
 */
export const awardProposal = (
  proposals: readonly Proposal[],
  proposalId: string,
): Result<AwardResult, JobRefusal> => {
  const accepted = proposals.find((proposal) => proposal.id === proposalId);
  if (accepted === undefined) return fail({ code: 'NO_PROPOSALS' });
  if (accepted.status !== 'PENDING') return fail({ code: 'PROPOSAL_NOT_PENDING' });

  const pending = proposals.filter((proposal) => proposal.status === 'PENDING');
  if (pending.length === 0) return fail({ code: 'NO_PROPOSALS' });

  return ok({
    accepted,
    rejected: pending.filter((proposal) => proposal.id !== proposalId),
    budget: accepted.bid,
  });
};

/* ------------------------------------------------------------------------ the milestones */

export type MilestoneStatus = 'PLANNED' | 'FUNDED' | 'SUBMITTED' | 'RELEASED';

export const MILESTONE_STATUSES: readonly MilestoneStatus[] = [
  'PLANNED',
  'FUNDED',
  'SUBMITTED',
  'RELEASED',
];

/**
 * The legal moves for a milestone.
 *
 * `FUNDED → SUBMITTED` is the freelancer delivering; `SUBMITTED → RELEASED` is the client
 * approving. There is no `SUBMITTED → FUNDED` because un-submitting would let a freelancer
 * withdraw delivered work after the client had started reviewing it — if the work is wrong, the
 * client disputes; they do not return it to a queue.
 */
const MILESTONE_MOVES: Readonly<Record<MilestoneStatus, readonly MilestoneStatus[]>> = {
  PLANNED: ['FUNDED'],
  FUNDED: ['SUBMITTED'],
  SUBMITTED: ['RELEASED'],
  RELEASED: [],
};

export const canMoveMilestone = (from: MilestoneStatus, to: MilestoneStatus): boolean =>
  MILESTONE_MOVES[from].includes(to);

export type Milestone = {
  readonly id: string;
  readonly amount: Money;
  readonly status: MilestoneStatus;
};

/**
 * The milestones must sum to the contract budget, exactly.
 *
 * Splitting a job into payments is where a marketplace discovers it has created money: three
 * milestones of "a third" of 10,000 cannot all be exact, and releasing them would pay out
 * 9,999 or 10,002. The plan is refused unless it adds up, so the rounding argument happens
 * once, at planning time, and never at payout time.
 */
export const checkMilestonePlan = (
  milestones: readonly { readonly amountMinor: number }[],
  budget: Money,
): JobRefusal | null => {
  if (milestones.length === 0 || milestones.length > MAX_MILESTONES) {
    return { code: 'MILESTONES_DO_NOT_ADD_UP', expected: budget.minor, actual: 0 };
  }

  if (milestones.some((milestone) => milestone.amountMinor <= 0)) {
    return { code: 'MILESTONES_DO_NOT_ADD_UP', expected: budget.minor, actual: 0 };
  }

  const actual = milestones.reduce((sum, milestone) => sum + milestone.amountMinor, 0);
  if (actual !== budget.minor) {
    return { code: 'MILESTONES_DO_NOT_ADD_UP', expected: budget.minor, actual };
  }

  return null;
};

/* ----------------------------------------------------------------------------- the money */

export type EscrowState = {
  /** What the client has paid in. */
  readonly funded: Money;
  /** What has been paid out to the freelancer. */
  readonly released: Money;
  readonly disputeOpen: boolean;
};

/**
 * How much of the escrow is still held.
 *
 * Expressed as a function rather than a column so it cannot drift: a stored "remaining" is a
 * second source of truth that a failed release updates and a successful one forgets.
 */
export const heldOf = (state: EscrowState): Money => ({
  currency: state.funded.currency,
  minor: state.funded.minor - state.released.minor,
});

export type ReleaseCheck = EscrowState & {
  readonly amount: Money;
  readonly budget: Money;
};

/**
 * Whether a release may happen.
 *
 * Three refusals, in the order that matters to the person reading the message: an open dispute
 * freezes everything (including a release a client had already approved), a release cannot
 * exceed what is being held, and an empty escrow is not an error to retry but a fact.
 */
export const checkRelease = (input: ReleaseCheck): JobRefusal | null => {
  if (input.amount.currency !== input.funded.currency) return { code: 'CURRENCY_MISMATCH' };
  if (input.disputeOpen) return { code: 'DISPUTE_OPEN' };

  const held = heldOf(input);
  if (held.minor <= 0) return { code: 'ALREADY_RELEASED' };
  if (input.amount.minor > held.minor) {
    return { code: 'MILESTONES_DO_NOT_ADD_UP', expected: held.minor, actual: input.amount.minor };
  }

  if (input.released.minor + input.amount.minor > input.budget.minor) {
    return {
      code: 'MILESTONES_DO_NOT_ADD_UP',
      expected: input.budget.minor,
      actual: input.released.minor + input.amount.minor,
    };
  }

  return null;
};

export type PlatformFee = {
  readonly fee: Money;
  readonly toFreelancer: Money;
};

/**
 * The platform's cut of a released milestone.
 *
 * The fee comes out of the freelancer's side, not the client's: the client funded the budget
 * and the budget is what they pay, so a fee charged on top would make the invoice disagree with
 * the contract. `computeSplit` is reused so the conservation rule — fee + net = gross, exactly,
 * to the last paisa — is the same one the market uses.
 */
export const WORK_FEE_BPS = 500;

export const computeReleaseSplit = (
  gross: Money,
  feeBps: number = WORK_FEE_BPS,
): Result<PlatformFee, { readonly code: 'FEE_OUT_OF_RANGE'; readonly feeBps: number }> => {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 5_000) {
    return fail({ code: 'FEE_OUT_OF_RANGE', feeBps });
  }

  const feeMinor = Math.round((gross.minor * feeBps) / 10_000);
  return ok({
    fee: { currency: gross.currency, minor: feeMinor },
    toFreelancer: { currency: gross.currency, minor: gross.minor - feeMinor },
  });
};

/* --------------------------------------------------------------------------- the dispute */

export type DisputeOutcome = 'RELEASED_TO_FREELANCER' | 'REFUNDED_TO_CLIENT';

export type DisputeResolution = {
  readonly outcome: DisputeOutcome;
  readonly toFreelancer: Money;
  readonly toClient: Money;
};

/**
 * Resolves a dispute by splitting the held amount.
 *
 * The parts must sum to the held amount, which is why the caller supplies one side and this
 * computes the other: a resolution form that accepted both numbers would let support pay out
 * 9,000 and refund 4,000 from a 10,000 escrow.
 *
 * `toFreelancerMinor` wins whenever it is given, including for the two all-or-nothing
 * outcomes. The first version of this function let the outcome decide and silently ignored a
 * supplied amount — so a caller asking to refund 60,000 of 60,000 while splitting 59,999 to
 * the freelancer got a full refund and no error. An argument that can be silently discarded is
 * worse than one that is refused.
 */
export const resolveDispute = (
  held: Money,
  outcome: DisputeOutcome,
  toFreelancerMinor?: number,
): Result<DisputeResolution, JobRefusal> => {
  const implicit =
    outcome === 'RELEASED_TO_FREELANCER' ? held.minor : outcome === 'REFUNDED_TO_CLIENT' ? 0 : null;

  const toFreelancer = toFreelancerMinor ?? implicit;
  if (toFreelancer === null) {
    // A split was asked for without saying how much goes to each side.
    return fail({ code: 'MILESTONES_DO_NOT_ADD_UP', expected: held.minor, actual: 0 });
  }

  if (!Number.isInteger(toFreelancer) || toFreelancer < 0 || toFreelancer > held.minor) {
    return fail({ code: 'MILESTONES_DO_NOT_ADD_UP', expected: held.minor, actual: toFreelancer });
  }

  return ok({
    outcome,
    toFreelancer: { currency: held.currency, minor: toFreelancer },
    toClient: { currency: held.currency, minor: held.minor - toFreelancer },
  });
};
