/**
 * Work contracts.
 *
 * Four boundaries, each with one job:
 *
 *   the *job*        what a client advertises: title, description, budget, deadline.
 *   the *proposal*   what a freelancer offers: a bid at or below the budget, a pitch, a
 *                    delivery estimate in days.
 *   the *move*       a named transition (`START`, `SUBMIT`, `APPROVE`, …) rather than a status
 *                    field, so a route cannot be used to write an arbitrary state.
 *   the *plan*       the milestones a contract is split into. The amounts must add up, and the
 *                    schema says so instead of the caller.
 *
 * Money is a **decimal string** on the wire for the same reason it is in the market: a JSON
 * number is a double the moment it is parsed, and a budget typed as `0.1 + 0.2` in a form is
 * exactly the class of bug the integer-minor-unit rule exists to prevent.
 */

import { z } from 'zod';

export const JOB_STATUSES = [
  'DRAFT',
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PROPOSAL_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const MILESTONE_STATUSES = ['PLANNED', 'FUNDED', 'SUBMITTED', 'RELEASED'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const WORK_CURRENCIES = ['BDT', 'USD', 'EUR', 'GBP', 'INR'] as const;
export type WorkCurrency = (typeof WORK_CURRENCIES)[number];

export const MIN_BUDGET_MINOR = 5_000;
export const MAX_BUDGET_MINOR = 500_000_000;
export const MAX_MILESTONES = 10;
export const MAX_DELIVERY_DAYS = 365;
/** How far ahead a job may be advertised. A year matches the kernel's horizon. */
export const MAX_DEADLINE_DAYS = 365;

const MONEY_PATTERN = /^\d{1,9}(\.\d{1,2})?$/u;

/**
 * A money amount as a person types it.
 *
 * The pattern refuses more precision than a paisa, exponents and a leading `+`; the transform
 * produces integer minor units, so the service, the database and the receipt all work with the
 * same exact number.
 */
const moneyInput = (options: { readonly min: number; readonly max: number }) =>
  z
    .string()
    .trim()
    .regex(MONEY_PATTERN, 'An amount like 250 or 250.50')
    .transform((value) => {
      const [whole = '0', fraction = ''] = value.split('.');
      return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    })
    .refine(
      (minor) => minor >= options.min,
      `The lowest amount is ${(options.min / 100).toFixed(2)}`,
    )
    .refine((minor) => minor <= options.max, 'That amount is too high');

const budgetSchema = moneyInput({ min: MIN_BUDGET_MINOR, max: MAX_BUDGET_MINOR });

const categorySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u, 'Lowercase letters, digits and single hyphens')
  .default('general');

export const createJobRequestSchema = z
  .object({
    title: z.string().trim().min(8, 'A title needs at least 8 characters').max(120),
    description: z.string().max(8_000).default(''),
    category: categorySchema,
    budget: budgetSchema,
    currency: z.enum(WORK_CURRENCIES).default('BDT'),
    /** An ISO instant. The kernel checks it against the clock and the horizon. */
    deadline: z.string().datetime({ offset: true }),
    /** A draft is only visible to its client; going live needs a budget and a deadline. */
    status: z.enum(['DRAFT', 'OPEN']).default('OPEN'),
  })
  .strict();

export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;
export type CreateJobRequestInput = z.input<typeof createJobRequestSchema>;

export const updateJobRequestSchema = z
  .object({
    title: z.string().trim().min(8).max(120).optional(),
    description: z.string().max(8_000).optional(),
    category: categorySchema.optional(),
    budget: budgetSchema.optional(),
    deadline: z.string().datetime({ offset: true }).optional(),
    status: z.enum(JOB_STATUSES).optional(),
  })
  .strict()
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    'Nothing to change',
  );

export type UpdateJobRequest = z.infer<typeof updateJobRequestSchema>;
export type UpdateJobRequestInput = z.input<typeof updateJobRequestSchema>;

export const createProposalRequestSchema = z
  .object({
    /** At or below the job's budget. Asking for less is a negotiation, not an error. */
    bid: budgetSchema,
    coverLetter: z.string().trim().min(20, 'Say a little more than "I can do it"').max(4_000),
    deliveryDays: z.coerce.number().int().min(1).max(MAX_DELIVERY_DAYS),
  })
  .strict();

export type CreateProposalRequest = z.infer<typeof createProposalRequestSchema>;
export type CreateProposalRequestInput = z.input<typeof createProposalRequestSchema>;

/** A named action, because `PATCH { status }` would be a second way in with no state machine. */
export const JOB_ACTIONS = ['AWARD', 'START', 'COMPLETE', 'CANCEL'] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

export const jobActionRequestSchema = z
  .object({
    action: z.enum(JOB_ACTIONS),
    /** Required for `AWARD`: the proposal being accepted. */
    proposalId: z.string().uuid().optional(),
    /** Required for `AWARD`: the milestones the contract is split into. */
    milestones: z
      .array(
        z
          .object({
            title: z.string().trim().min(2).max(120),
            amount: budgetSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_MILESTONES)
      .optional(),
  })
  .strict()
  .refine((input) => input.action !== 'AWARD' || input.proposalId !== undefined, {
    message: 'Awarding needs the proposal to accept',
    path: ['proposalId'],
  })
  .refine((input) => input.action !== 'AWARD' || input.milestones !== undefined, {
    message: 'Awarding needs the payment plan',
    path: ['milestones'],
  });

export type JobActionRequest = z.infer<typeof jobActionRequestSchema>;
export type JobActionRequestInput = z.input<typeof jobActionRequestSchema>;

export const MILESTONE_ACTIONS = ['FUND', 'SUBMIT', 'APPROVE'] as const;
export type MilestoneAction = (typeof MILESTONE_ACTIONS)[number];

export const milestoneActionRequestSchema = z
  .object({
    action: z.enum(MILESTONE_ACTIONS),
    /** Only for `APPROVE` on a disputed contract, which is the platform's act. */
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

export type MilestoneActionRequest = z.infer<typeof milestoneActionRequestSchema>;

export const jobQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(120).optional(),
    /** A prefix match on the title, case-folded. */
    q: z.string().trim().max(80).optional(),
    category: z.string().trim().max(40).optional(),
    /** Only jobs whose deadline has not passed, which is the default board. */
    openOnly: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    mine: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export type JobQuery = z.infer<typeof jobQuerySchema>;

export type WorkPartyResponse = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
};

export type MilestoneResponse = {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly amountMinor: number;
  readonly status: MilestoneStatus;
  readonly submittedAt: string | null;
  readonly releasedAt: string | null;
};

export type JobSummaryResponse = {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly budgetMinor: number;
  readonly currency: WorkCurrency;
  readonly status: JobStatus;
  readonly deadline: string;
  readonly client: WorkPartyResponse;
  /** True when the caller is the client, so the UI can offer editing without a second call. */
  readonly isClient: boolean;
  /** True when the caller already has a live proposal, so the UI hides the form. */
  readonly hasProposed: boolean;
  readonly proposalCount: number;
  /** Whether the deadline has passed, computed by the server so every client agrees. */
  readonly isAcceptingProposals: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type JobResponse = JobSummaryResponse & {
  readonly description: string;
  /** The caller's own proposal, if they made one. Everyone sees only their own until award. */
  readonly myProposal: ProposalResponse | null;
};

export type JobListResponse = {
  readonly items: readonly JobSummaryResponse[];
  readonly nextCursor: string | null;
};

export type ProposalResponse = {
  readonly id: string;
  readonly jobId: string;
  readonly freelancer: WorkPartyResponse;
  readonly bidMinor: number;
  readonly currency: WorkCurrency;
  readonly coverLetter: string;
  readonly deliveryDays: number;
  readonly status: ProposalStatus;
  readonly createdAt: string;
};

export type ContractResponse = {
  readonly id: string;
  readonly jobId: string;
  readonly jobTitle: string;
  readonly client: WorkPartyResponse;
  readonly freelancer: WorkPartyResponse;
  readonly amountMinor: number;
  readonly currency: WorkCurrency;
  readonly status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'DISPUTED';
  readonly milestones: readonly MilestoneResponse[];
  /** What the escrow holds: funded minus released, derived from the ledger. */
  readonly heldMinor: number;
  readonly releasedMinor: number;
  readonly isClient: boolean;
  readonly isFreelancer: boolean;
  /** The actions *this* caller may take now, so the UI never offers a refused button. */
  readonly availableActions: readonly MilestoneAction[];
  readonly disputeOpen: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ContractListResponse = {
  readonly items: readonly ContractResponse[];
  readonly nextCursor: string | null;
};

/** Everything a screen needs to explain a refusal in the person's own words. */
export const WORK_FAILURES = {
  OWN_JOB: 'You cannot propose on your own job',
  JOB_NOT_OPEN: 'That job is no longer accepting proposals',
  ALREADY_APPLIED: 'You already have a proposal on this job',
  BID_EXCEEDS_BUDGET: 'Your bid is above the budget the client posted',
  MILESTONES_DO_NOT_ADD_UP: 'The milestones must add up to the agreed amount',
  DISPUTE_OPEN: 'The money is frozen while the dispute is open',
  ALREADY_RELEASED: 'There is nothing left to release',
  NOT_FUNDED: 'Fund the milestone before releasing it',
  BLOCKED: 'You cannot work with this account',
} as const;
