/**
 * Work ports.
 *
 * Four stores, because the four aggregates have genuinely different transactional shapes:
 *
 *   * a **job** is one row plus a status move;
 *   * a **proposal** is one row, with the job's award as a *second* write in the same
 *     transaction — accepting a proposal and closing the others is atomic or it is a job that
 *     shows an award and still collects bids;
 *   * a **contract** is the job's outcome, its plan, and its escrow ledger, created together;
 *   * an **escrow entry** is append-only, and the balance is a `sum()` rather than a column,
 *     so there is no "update the balance" method to forget to call.
 *
 * The one rule shared by all four: every read that decides *who may see this* takes the
 * viewer's id. Visibility is a `WHERE` clause, never a check the caller might skip.
 */

export type WorkParty = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
};

export type JobRecord = {
  readonly id: string;
  readonly clientId: string;
  readonly client: WorkParty;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly budgetMinor: number;
  readonly currency: string;
  readonly status: 'DRAFT' | 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  readonly deadline: Date;
  readonly assignedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type JobListQuery = {
  readonly viewerId: string;
  readonly limit: number;
  readonly cursor: string | null;
  readonly search: string | null;
  readonly category: string | null;
  readonly openOnly: boolean;
  readonly mine: boolean;
};

export type JobListRow = {
  readonly job: JobRecord;
  readonly proposalCount: number;
  /** Whether the viewer has a live (pending or accepted) proposal on this job. */
  readonly viewerProposed: boolean;
};

export type JobPage = {
  readonly items: readonly JobListRow[];
};

export type JobStore = {
  list(query: JobListQuery): Promise<JobPage>;
  find(viewerId: string, id: string): Promise<JobListRow | null>;
  create(job: JobRecord): Promise<JobRecord>;
  update(
    clientId: string,
    id: string,
    patch: {
      readonly title?: string;
      readonly description?: string;
      readonly category?: string;
      readonly budgetMinor?: number;
      readonly deadline?: Date;
      readonly status?: JobRecord['status'];
      readonly assignedAt?: Date | null;
    },
  ): Promise<JobRecord | null>;
};

export type ProposalRecord = {
  readonly id: string;
  readonly jobId: string;
  readonly freelancerId: string;
  readonly freelancer: WorkParty;
  readonly bidMinor: number;
  readonly currency: string;
  readonly coverLetter: string;
  readonly deliveryDays: number;
  readonly status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN';
  readonly createdAt: Date;
};

export type ProposalStore = {
  listForJob(jobId: string): Promise<readonly ProposalRecord[]>;
  find(id: string): Promise<ProposalRecord | null>;
  create(proposal: ProposalRecord): Promise<ProposalRecord | null>;
  /**
   * Accepts one proposal, closes the others and moves the job to `ASSIGNED`, in one
   * transaction.
   *
   * Returning all three effects as one method is deliberate: a caller that could accept a
   * proposal without closing the rest would leave a job that reads as filled while a dozen
   * people still believe they are being considered.
   */
  award(input: {
    readonly jobId: string;
    readonly proposalId: string;
    readonly at: Date;
  }): Promise<AwardOutcome | null>;
  withdraw(freelancerId: string, id: string): Promise<boolean>;
};

export type AwardOutcome =
  | { readonly kind: 'AWARDED'; readonly accepted: ProposalRecord; readonly rejected: number }
  | { readonly kind: 'NOT_PENDING' }
  | { readonly kind: 'JOB_NOT_OPEN' };

export type MilestoneRecord = {
  readonly id: string;
  readonly contractId: string;
  readonly position: number;
  readonly title: string;
  readonly amountMinor: number;
  readonly status: 'PLANNED' | 'FUNDED' | 'SUBMITTED' | 'RELEASED';
  readonly submittedAt: Date | null;
  readonly releasedAt: Date | null;
};

export type EscrowEntryRecord = {
  readonly kind: 'FUND' | 'RELEASE' | 'REFUND' | 'FEE';
  readonly amountMinor: number;
  readonly actor: 'CLIENT' | 'FREELANCER' | 'PLATFORM';
  readonly at: Date;
};

export type ContractRecord = {
  readonly id: string;
  readonly jobId: string;
  readonly jobTitle: string;
  readonly clientId: string;
  readonly freelancerId: string;
  readonly client: WorkParty;
  readonly freelancer: WorkParty;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'DISPUTED';
  readonly disputeOpen: boolean;
  readonly milestones: readonly MilestoneRecord[];
  /** Derived from the ledger, never stored. */
  readonly heldMinor: number;
  readonly releasedMinor: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ContractListQuery = {
  readonly viewerId: string;
  readonly limit: number;
  readonly cursor: string | null;
};

export type ContractStore = {
  list(query: ContractListQuery): Promise<{ readonly items: readonly ContractRecord[] }>;
  find(viewerId: string, id: string): Promise<ContractRecord | null>;
  /**
   * A read with no visibility filter, for the platform's dispute desk.
   *
   * Kept separate from `find` rather than made an option on it: the only caller that may skip
   * the filter is one that has already proved it is staff, and a `viewerId: null` overload is
   * an invitation to pass null from the wrong place.
   */
  findForOperator(id: string): Promise<ContractRecord | null>;
  /** Creates the contract, its milestones and the client's funding entry as one unit. */
  create(input: {
    readonly id: string;
    readonly jobId: string;
    readonly clientId: string;
    readonly freelancerId: string;
    readonly amountMinor: number;
    readonly currency: string;
    /**
     * The plan, in order. The store writes each one and, since the client is paying at award
     * time, funds it in the same transaction — a plan of milestones that exists while nothing
     * is held would be a contract the freelancer cannot be paid from.
     */
    readonly milestones: readonly {
      readonly id: string;
      readonly title: string;
      readonly amountMinor: number;
    }[];
    readonly at: Date;
  }): Promise<ContractRecord>;
  setStatus(id: string, status: ContractRecord['status'], at: Date): Promise<void>;
  /**
   * Moves one milestone and writes the escrow entries that pay for it, in one transaction.
   *
   * `FUND` writes the positive entry from the milestone's own amount; `RELEASED` writes the net
   * and the platform fee. There is no separate "fund" call, because a funded milestone with no
   * entry is money that was promised but never held.
   */
  moveMilestone(input: {
    readonly contractId: string;
    readonly milestoneId: string;
    readonly from: MilestoneRecord['status'];
    readonly to: MilestoneRecord['status'];
    readonly at: Date;
    readonly escrow?: {
      readonly feeMinor: number;
      readonly netMinor: number;
    };
  }): Promise<boolean>;
  openDispute(contractId: string, reason: string, at: Date): Promise<boolean>;
  resolveDispute(input: {
    readonly contractId: string;
    readonly outcome: 'RELEASED_TO_FREELANCER' | 'REFUNDED_TO_CLIENT';
    readonly toFreelancerMinor: number;
    readonly currency: string;
    readonly at: Date;
  }): Promise<void>;
};
