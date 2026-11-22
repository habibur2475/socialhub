/**
 * Work use cases.
 *
 * The policy lives in the kernel (`decideJobMove`, `checkProposal`, `awardProposal`,
 * `checkMilestonePlan`, `checkRelease`, `computeReleaseSplit`, `resolveDispute`). This service
 * assembles what those functions need, refuses when they say no, and adds the two things a pure
 * function cannot know: **who is asking** and **what the current rows say**.
 *
 * Four decisions worth stating:
 *
 * 1. **Awarding is one transaction, and the mileage is planned before it happens.** The
 *    `AWARD` action carries both the proposal and the milestone plan, so a job can never be
 *    awarded without a payment plan that adds up. The alternative — award, then plan — has a
 *    window in which a contract exists that nobody can pay.
 * 2. **A contract is funded when it is created.** The client agreed to the plan and paid for it
 *    at award time; a milestone that exists in `PLANNED` while the UI says "in progress" is an
 *    escrow that does not exist.
 * 3. **The fee is taken at release, and its arithmetic is the kernel's.** The client pays the
 *    agreed amount and nothing more; the platform's cut comes out of the freelancer's side.
 * 4. **A dispute freezes; support resolves.** No route lets either party release money after a
 *    dispute is opened, which is the whole point of opening one.
 */

import { Inject, Injectable } from '@nestjs/common';

import {
  appError,
  awardProposal,
  checkJobForPublishing,
  checkMilestonePlan,
  checkProposal,
  checkRelease,
  computeReleaseSplit,
  canMoveMilestone,
  decideJobMove,
  resolveDispute,
  type JobActor,
  type JobStatus,
  type MilestoneStatus,
} from '@socialhub/kernel';
import type {
  ContractListResponse,
  ContractResponse,
  CreateJobRequest,
  CreateProposalRequest,
  JobActionRequest,
  JobListResponse,
  JobQuery,
  JobResponse,
  JobSummaryResponse,
  MilestoneActionRequest,
  MilestoneResponse,
  MilestoneAction,
  WorkCurrency,
} from '@socialhub/contracts';

import { DomainException } from '../../../common/filters/domain-exception.js';
import type { Clock, IdGenerator } from '../../auth/application/ports.js';
import { CLOCK, IDS } from '../../auth/auth.tokens.js';
import type {
  ContractRecord,
  ContractStore,
  JobListRow,
  JobStore,
  ProposalRecord,
  ProposalStore,
} from './ports.js';
import { CONTRACT_STORE, JOB_STORE, PROPOSAL_STORE } from '../work.tokens.js';

/**
 * A job action, the states it may start from, and who performs it.
 *
 * `requestedBy` is separate from `actor`: `CANCEL` in `IN_PROGRESS` is the platform's move even
 * though a client may ask for it, so the request is checked against `requestedBy` and the
 * transition against `actor`.
 */
type JobMove = {
  readonly from: readonly JobStatus[];
  readonly to: JobStatus;
  readonly actor: JobActor;
  readonly requestedBy: 'CLIENT' | 'FREELANCER';
};

const MOVE_FOR_ACTION: Readonly<Record<JobActionRequest['action'], JobMove>> = {
  AWARD: { from: ['OPEN'], to: 'ASSIGNED', actor: 'CLIENT', requestedBy: 'CLIENT' },
  START: { from: ['ASSIGNED'], to: 'IN_PROGRESS', actor: 'FREELANCER', requestedBy: 'FREELANCER' },
  COMPLETE: { from: ['IN_PROGRESS'], to: 'COMPLETED', actor: 'CLIENT', requestedBy: 'CLIENT' },
  CANCEL: {
    from: ['DRAFT', 'OPEN', 'ASSIGNED'],
    to: 'CANCELLED',
    actor: 'CLIENT',
    requestedBy: 'CLIENT',
  },
};

const moveFor = (action: JobActionRequest['action']): JobMove =>
  MOVE_FOR_ACTION[action] ?? MOVE_FOR_ACTION.CANCEL;

/** A message a person can act on, per refusal code. */
const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  OWN_JOB: 'You cannot propose on your own job',
  JOB_NOT_OPEN: 'That job is no longer accepting proposals',
  ALREADY_APPLIED: 'You already have a proposal on this job',
  BID_EXCEEDS_BUDGET: 'Your bid is above the budget the client posted',
  MILESTONES_DO_NOT_ADD_UP: 'The milestones must add up to the agreed amount',
  DISPUTE_OPEN: 'The money is frozen while the dispute is open',
  ALREADY_RELEASED: 'There is nothing left to release',
  NOT_FUNDED: 'Fund the milestone before releasing it',
  BLOCKED: 'You cannot work with this account',
  INVALID_TRANSITION: 'That is not something you can do to this job yet',
  NOT_YOUR_JOB: 'That job is not yours',
  BUDGET_TOO_LOW: 'That budget is below the minimum',
  BUDGET_TOO_HIGH: 'That budget is above the maximum',
  DEADLINE_IN_PAST: 'The deadline has already passed',
  DEADLINE_TOO_FAR: 'A job cannot be advertised more than a year ahead',
  PROPOSAL_NOT_PENDING: 'That proposal is no longer open',
  NO_PROPOSALS: 'There is no proposal to accept',
  CURRENCY_MISMATCH: 'Those amounts are in different currencies',
};

@Injectable()
export class WorkService {
  public constructor(
    @Inject(JOB_STORE) private readonly jobs: JobStore,
    @Inject(PROPOSAL_STORE) private readonly proposals: ProposalStore,
    @Inject(CONTRACT_STORE) private readonly contracts: ContractStore,
    @Inject(IDS) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Refuses with the refusal's own message, so every route explains itself the same way. */
  private refuse(code: string): never {
    throw new DomainException(appError('VALIDATION_FAILED', REFUSAL_MESSAGES[code] ?? code));
  }

  /* --------------------------------------------------------------------------- the board */

  private toSummary(row: JobListRow, viewerId: string): JobSummaryResponse {
    const { job, proposalCount, viewerProposed } = row;

    return {
      id: job.id,
      title: job.title,
      category: job.category,
      budgetMinor: job.budgetMinor,
      currency: job.currency as WorkCurrency,
      status: job.status,
      deadline: job.deadline.toISOString(),
      client: job.client,
      isClient: job.clientId === viewerId,
      hasProposed: viewerProposed,
      proposalCount,
      // Computed here, against the clock this service was given, so every client agrees.
      isAcceptingProposals:
        job.status === 'OPEN' && job.deadline.getTime() > this.clock().getTime(),
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  public async listJobs(viewerId: string, query: JobQuery): Promise<JobListResponse> {
    const page = await this.jobs.list({
      viewerId,
      limit: query.limit,
      cursor: query.cursor ?? null,
      search: query.q ?? null,
      category: query.category ?? null,
      openOnly: query.openOnly,
      mine: query.mine,
    });

    const last = page.items[page.items.length - 1];
    const nextCursor =
      last === undefined || page.items.length < query.limit
        ? null
        : `${last.job.createdAt.toISOString()}|${last.job.id}`;

    return { items: page.items.map((row) => this.toSummary(row, viewerId)), nextCursor };
  }

  public async job(viewerId: string, id: string): Promise<JobResponse> {
    const row = await this.jobs.find(viewerId, id);
    if (row === null) throw new DomainException(appError('NOT_FOUND', 'Job not found'));

    const summary = this.toSummary(row, viewerId);
    const mine = summary.hasProposed
      ? (await this.proposals.listForJob(id)).find((proposal) => proposal.freelancerId === viewerId)
      : undefined;

    return {
      ...summary,
      description: row.job.description,
      myProposal: mine === undefined ? null : this.toProposal(mine),
    };
  }

  public async createJob(clientId: string, input: CreateJobRequest): Promise<JobResponse> {
    const now = this.clock();
    const deadline = new Date(input.deadline);

    const refusal = checkJobForPublishing(
      { budgetMinor: input.budget, deadline, title: input.title },
      { now },
    );
    if (refusal !== null) this.refuse(refusal.code);

    const created = await this.jobs.create({
      id: this.ids.next(),
      clientId,
      client: { accountId: clientId, username: '', displayName: '', avatarKey: null },
      title: input.title,
      description: input.description,
      category: input.category,
      budgetMinor: input.budget,
      currency: input.currency,
      status: input.status,
      deadline,
      assignedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    return this.job(clientId, created.id);
  }

  public async updateJob(
    clientId: string,
    id: string,
    patch: {
      readonly title?: string | undefined;
      readonly description?: string | undefined;
      readonly category?: string | undefined;
      readonly budget?: number | undefined;
      readonly deadline?: string | undefined;
      readonly status?: JobStatus | undefined;
    },
  ): Promise<JobResponse> {
    const existing = await this.jobs.find(clientId, id);
    if (existing === null || existing.job.clientId !== clientId) {
      // `404`, not `403`: someone else's draft is not disclosed, and the same answer is what a
      // job that never existed returns.
      throw new DomainException(appError('NOT_FOUND', 'Job not found'));
    }

    const deadline =
      patch.deadline === undefined ? existing.job.deadline : new Date(patch.deadline);
    const budgetMinor = patch.budget ?? existing.job.budgetMinor;

    const refusal = checkJobForPublishing(
      {
        budgetMinor,
        deadline,
        title: patch.title ?? existing.job.title,
      },
      { now: this.clock() },
    );
    if (refusal !== null) this.refuse(refusal.code);

    await this.jobs.update(clientId, id, {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.category === undefined ? {} : { category: patch.category }),
      ...(patch.budget === undefined ? {} : { budgetMinor: patch.budget }),
      ...(patch.deadline === undefined ? {} : { deadline }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
    });

    return this.job(clientId, id);
  }

  /* ------------------------------------------------------------------------ the proposals */

  private toProposal(proposal: ProposalRecord): NonNullable<JobResponse['myProposal']> {
    return {
      id: proposal.id,
      jobId: proposal.jobId,
      freelancer: proposal.freelancer,
      bidMinor: proposal.bidMinor,
      currency: proposal.currency as WorkCurrency,
      coverLetter: proposal.coverLetter,
      deliveryDays: proposal.deliveryDays,
      status: proposal.status,
      createdAt: proposal.createdAt.toISOString(),
    };
  }

  /**
   * The proposals on a job — the client's view, and only the client's.
   *
   * A freelancer sees their own proposal through `job()` and nobody else's: a list of everyone
   * who applied, with their prices, is a competitor's price list.
   */
  public async proposalsForJob(
    viewerId: string,
    jobId: string,
  ): Promise<readonly ReturnType<WorkService['toProposal']>[]> {
    const row = await this.jobs.find(viewerId, jobId);
    if (row === null) throw new DomainException(appError('NOT_FOUND', 'Job not found'));
    if (row.job.clientId !== viewerId) {
      throw new DomainException(appError('FORBIDDEN', 'Only the client sees the proposals'));
    }

    const all = await this.proposals.listForJob(jobId);
    return all.map((proposal) => this.toProposal(proposal));
  }

  public async propose(
    freelancerId: string,
    jobId: string,
    input: CreateProposalRequest,
  ): Promise<NonNullable<JobResponse['myProposal']>> {
    const row = await this.jobs.find(freelancerId, jobId);
    if (row === null) throw new DomainException(appError('NOT_FOUND', 'Job not found'));

    const existing = await this.proposals.listForJob(jobId);

    const refusal = checkProposal({
      job: {
        id: row.job.id,
        clientId: row.job.clientId,
        status: row.job.status,
        budget: { currency: row.job.currency as 'BDT', minor: row.job.budgetMinor },
        deadline: row.job.deadline,
      },
      clientId: row.job.clientId,
      freelancerId,
      bidMinor: input.bid,
      existing: existing.map((proposal) => ({
        id: proposal.id,
        jobId: proposal.jobId,
        freelancerId: proposal.freelancerId,
        status: proposal.status,
        bid: { currency: proposal.currency as 'BDT', minor: proposal.bidMinor },
        deliveryDays: proposal.deliveryDays,
      })),
      blocked: false,
    });

    if (refusal !== null) this.refuse(refusal.code);

    const created = await this.proposals.create({
      id: this.ids.next(),
      jobId,
      freelancerId,
      freelancer: { accountId: freelancerId, username: '', displayName: '', avatarKey: null },
      bidMinor: input.bid,
      currency: row.job.currency,
      coverLetter: input.coverLetter,
      deliveryDays: input.deliveryDays,
      status: 'PENDING',
      createdAt: this.clock(),
    });

    // The partial unique index is the final authority; reaching this means two requests raced.
    if (created === null) this.refuse('ALREADY_APPLIED');

    return this.toProposal(created);
  }

  public async withdrawProposal(freelancerId: string, id: string): Promise<void> {
    const withdrawn = await this.proposals.withdraw(freelancerId, id);
    if (!withdrawn) {
      throw new DomainException(appError('CONFLICT', 'That proposal is already answered or gone'));
    }
  }

  /* --------------------------------------------------------------------------- the award */

  public async actOnJob(
    actorId: string,
    jobId: string,
    input: JobActionRequest,
  ): Promise<{ readonly job: JobResponse; readonly contractId: string | null }> {
    const row = await this.jobs.find(actorId, jobId);
    if (row === null) throw new DomainException(appError('NOT_FOUND', 'Job not found'));

    const move = moveFor(input.action);
    const now = this.clock();

    if (!move.from.includes(row.job.status)) {
      this.refuse('INVALID_TRANSITION');
    }

    // Who is asking, in the actor's own terms: the client of this job, or its freelancer.
    const acceptedProposals = await this.proposals.listForJob(jobId);
    const accepted = acceptedProposals.find((proposal) => proposal.status === 'ACCEPTED');
    const freelancerId = accepted?.freelancerId ?? null;

    const isClient = row.job.clientId === actorId;
    const isFreelancer = freelancerId === actorId;

    if (move.requestedBy === 'CLIENT' && !isClient) {
      throw new DomainException(appError('NOT_FOUND', 'Job not found'));
    }
    if (move.requestedBy === 'FREELANCER' && !isFreelancer) {
      throw new DomainException(appError('NOT_FOUND', 'Job not found'));
    }

    const decision = decideJobMove(move.to, {
      job: {
        id: row.job.id,
        clientId: row.job.clientId,
        status: row.job.status,
        budget: { currency: row.job.currency as 'BDT', minor: row.job.budgetMinor },
        deadline: row.job.deadline,
      },
      actor: move.actor,
      actorId,
      freelancerId,
      blocked: false,
    });

    if (!decision.ok) this.refuse(decision.error.code);

    if (input.action === 'AWARD') return this.award(actorId, jobId, input, now);

    await this.jobs.update(actorId, jobId, { status: move.to });
    return { job: await this.job(actorId, jobId), contractId: null };
  }

  /**
   * Awards a job: accepts one proposal, closes the rest, and creates the funded contract.
   *
   * The order matters. The proposal store's `award()` is its own transaction and also moves the
   * job to `ASSIGNED`; if the plan is refused afterwards, the award must be undone rather than
   * left as a job that is filled but unpaid. The plan is therefore checked **before** the
   * award, against the bid, which is the amount the contract will actually be for.
   */
  private async award(
    clientId: string,
    jobId: string,
    input: JobActionRequest,
    now: Date,
  ): Promise<{ readonly job: JobResponse; readonly contractId: string }> {
    const proposalId = input.proposalId;
    if (proposalId === undefined) this.refuse('NO_PROPOSALS');

    const all = await this.proposals.listForJob(jobId);
    const outcome = awardProposal(
      all.map((proposal) => ({
        id: proposal.id,
        jobId: proposal.jobId,
        freelancerId: proposal.freelancerId,
        status: proposal.status,
        bid: { currency: proposal.currency as 'BDT', minor: proposal.bidMinor },
        deliveryDays: proposal.deliveryDays,
      })),
      proposalId,
    );

    if (!outcome.ok) this.refuse(outcome.error.code);

    const plan = input.milestones ?? [];
    const budget = outcome.value.budget;
    const planRefusal = checkMilestonePlan(
      plan.map((milestone) => ({ amountMinor: milestone.amount })),
      budget,
    );
    if (planRefusal !== null) this.refuse(planRefusal.code);

    const awarded = await this.proposals.award({ jobId, proposalId, at: now });
    if (awarded === null) throw new DomainException(appError('NOT_FOUND', 'Job not found'));
    if (awarded.kind === 'JOB_NOT_OPEN') this.refuse('JOB_NOT_OPEN');
    if (awarded.kind === 'NOT_PENDING') this.refuse('PROPOSAL_NOT_PENDING');

    const contract = await this.contracts.create({
      id: this.ids.next(),
      jobId,
      clientId,
      freelancerId: awarded.accepted.freelancerId,
      amountMinor: budget.minor,
      currency: awarded.accepted.currency,
      milestones: plan.map((milestone) => ({
        id: this.ids.next(),
        title: milestone.title,
        amountMinor: milestone.amount,
      })),
      at: now,
    });

    return { job: await this.job(clientId, jobId), contractId: contract.id };
  }

  /* ------------------------------------------------------------------------- the contract */

  private toMilestone(milestone: ContractRecord['milestones'][number]): MilestoneResponse {
    return {
      id: milestone.id,
      position: milestone.position,
      title: milestone.title,
      amountMinor: milestone.amountMinor,
      status: milestone.status,
      submittedAt: milestone.submittedAt?.toISOString() ?? null,
      releasedAt: milestone.releasedAt?.toISOString() ?? null,
    };
  }

  private toContract(contract: ContractRecord, viewerId: string): ContractResponse {
    const isClient = contract.clientId === viewerId;
    const isFreelancer = contract.freelancerId === viewerId;

    const availableActions: MilestoneAction[] = [];
    for (const milestone of contract.milestones) {
      if (milestone.status === 'FUNDED' && isFreelancer) availableActions.push('SUBMIT');
      if (milestone.status === 'SUBMITTED' && isClient) availableActions.push('APPROVE');
      if (milestone.status === 'PLANNED' && isClient) availableActions.push('FUND');
    }

    return {
      id: contract.id,
      jobId: contract.jobId,
      jobTitle: contract.jobTitle,
      client: contract.client,
      freelancer: contract.freelancer,
      amountMinor: contract.amountMinor,
      currency: contract.currency as WorkCurrency,
      status: contract.status,
      milestones: contract.milestones.map((milestone) => this.toMilestone(milestone)),
      heldMinor: contract.heldMinor,
      releasedMinor: contract.releasedMinor,
      isClient,
      isFreelancer,
      availableActions: [...new Set(availableActions)],
      disputeOpen: contract.disputeOpen,
      createdAt: contract.createdAt.toISOString(),
      updatedAt: contract.updatedAt.toISOString(),
    };
  }

  public async listContracts(
    viewerId: string,
    limit = 20,
    cursor: string | null = null,
  ): Promise<ContractListResponse> {
    const page = await this.contracts.list({ viewerId, limit, cursor });
    const last = page.items[page.items.length - 1];

    return {
      items: page.items.map((contract) => this.toContract(contract, viewerId)),
      nextCursor:
        last === undefined || page.items.length < limit
          ? null
          : `${last.createdAt.toISOString()}|${last.id}`,
    };
  }

  public async contract(viewerId: string, id: string): Promise<ContractResponse> {
    const found = await this.contracts.find(viewerId, id);
    if (found === null) throw new DomainException(appError('NOT_FOUND', 'Contract not found'));
    return this.toContract(found, viewerId);
  }

  /**
   * Moves one milestone: fund, submit, or approve-and-release.
   *
   * `APPROVE` is where money leaves the escrow, so it is also where the fee is computed and
   * where a dispute is checked. The order is: find the milestone, prove the caller is the party
   * this step belongs to, ask the kernel whether the release is allowed, then let the store do
   * the move and the ledger write in one transaction.
   */
  public async actOnMilestone(
    actorId: string,
    contractId: string,
    milestoneId: string,
    input: MilestoneActionRequest,
  ): Promise<ContractResponse> {
    const contract = await this.contracts.find(actorId, contractId);
    if (contract === null) throw new DomainException(appError('NOT_FOUND', 'Contract not found'));

    const milestone = contract.milestones.find((entry) => entry.id === milestoneId);
    if (milestone === undefined) {
      throw new DomainException(appError('NOT_FOUND', 'Milestone not found'));
    }

    const now = this.clock();
    const next: Record<MilestoneActionRequest['action'], MilestoneStatus> = {
      FUND: 'FUNDED',
      SUBMIT: 'SUBMITTED',
      APPROVE: 'RELEASED',
    };

    const to = next[input.action];

    // The step has to be the one this state allows. Without this, approving an already
    // released milestone would match `WHERE status = 'RELEASED'` and write a second payout —
    // the store's conditional update is a race guard, not a state machine.
    if (!canMoveMilestone(milestone.status, to)) {
      throw new DomainException(
        appError(
          'VALIDATION_FAILED',
          `“${milestone.title}” is ${milestone.status.toLowerCase().replaceAll('_', ' ')} — ${input.action.toLowerCase()} does not apply`,
        ),
      );
    }

    if (input.action === 'FUND' && contract.clientId !== actorId) {
      throw new DomainException(appError('NOT_FOUND', 'Contract not found'));
    }
    if (input.action === 'SUBMIT' && contract.freelancerId !== actorId) {
      throw new DomainException(appError('NOT_FOUND', 'Contract not found'));
    }
    if (input.action === 'APPROVE' && contract.clientId !== actorId) {
      throw new DomainException(appError('NOT_FOUND', 'Contract not found'));
    }

    const escrow =
      input.action === 'APPROVE' ? this.releasePlan(contract, milestone.amountMinor) : undefined;

    const moved = await this.contracts.moveMilestone({
      contractId,
      milestoneId,
      from: milestone.status,
      to,
      at: now,
      ...(escrow === undefined ? {} : { escrow }),
    });

    if (!moved) {
      // Somebody else moved it first. A retried approval must not pay twice, so this is a
      // conflict rather than a silent success.
      throw new DomainException(
        appError('CONFLICT', 'That step was already taken; refresh to see where it stands'),
      );
    }

    // Submitting work is also the freelancer starting it. A job whose freelancer has delivered a
    // milestone but never pressed "start" would be stuck in `ASSIGNED` for ever, and the state
    // machine's rule is that the *freelancer* brings a job into progress — which is exactly who
    // is calling here.
    if (input.action === 'SUBMIT') {
      const job = await this.jobs.find(contract.clientId, contract.jobId);
      if (job?.job.status === 'ASSIGNED') {
        await this.jobs.update(contract.clientId, contract.jobId, { status: 'IN_PROGRESS' });
      }
    }

    // The last milestone released closes the contract, and a finished job is a fact the board
    // should show rather than a status somebody has to remember to set.
    const after = await this.contracts.find(actorId, contractId);
    if (after !== null && after.milestones.every((entry) => entry.status === 'RELEASED')) {
      await this.contracts.setStatus(contractId, 'COMPLETED', now);

      const job = await this.jobs.find(contract.clientId, contract.jobId);
      if (job?.job.status === 'IN_PROGRESS') {
        await this.jobs.update(contract.clientId, contract.jobId, { status: 'COMPLETED' });
      }
    }

    return this.contract(actorId, contractId);
  }

  /** Asks the kernel whether this release is legal and, if so, how it splits. */
  private releasePlan(
    contract: ContractRecord,
    amountMinor: number,
  ): { readonly feeMinor: number; readonly netMinor: number } | undefined {
    const currency = contract.currency as 'BDT';
    const budget = { currency, minor: contract.amountMinor };
    const released = { currency, minor: contract.releasedMinor };

    const refusal = checkRelease({
      funded: { currency, minor: contract.releasedMinor + contract.heldMinor },
      released,
      disputeOpen: contract.disputeOpen,
      amount: { currency, minor: amountMinor },
      budget,
    });

    if (refusal !== null) {
      throw new DomainException(
        appError('PRECONDITION_FAILED', REFUSAL_MESSAGES[refusal.code] ?? refusal.code),
      );
    }

    const split = computeReleaseSplit({ currency, minor: amountMinor });
    if (!split.ok)
      throw new DomainException(appError('INTERNAL_ERROR', 'The fee could not be computed'));

    return { feeMinor: split.value.fee.minor, netMinor: split.value.toFreelancer.minor };
  }

  /* ------------------------------------------------------------------------- the dispute */

  public async openDispute(
    actorId: string,
    contractId: string,
    reason: string,
  ): Promise<ContractResponse> {
    const contract = await this.contracts.find(actorId, contractId);
    if (contract === null) throw new DomainException(appError('NOT_FOUND', 'Contract not found'));

    if (contract.disputeOpen) {
      throw new DomainException(appError('CONFLICT', 'A dispute is already open'));
    }

    const opened = await this.contracts.openDispute(contractId, reason, this.clock());
    if (!opened) throw new DomainException(appError('CONFLICT', 'A dispute is already open'));

    return this.contract(actorId, contractId);
  }

  /**
   * Resolves a dispute. **Platform only**, and checked here rather than in the route.
   *
   * It moves money back, which is why it is not one of the actions a participant can reach: the
   * caller's account type is the check, and it is made before the contract is even read.
   */
  public async resolve(
    operator: { readonly accountId: string; readonly accountType: string },
    contractId: string,
    outcome: 'RELEASED_TO_FREELANCER' | 'REFUNDED_TO_CLIENT',
    toFreelancerMinor?: number,
  ): Promise<ContractResponse> {
    if (operator.accountType === 'USER') {
      throw new DomainException(appError('FORBIDDEN', 'Only support can resolve a dispute'));
    }

    const contract = await this.contracts.findForOperator(contractId);
    if (contract === null) throw new DomainException(appError('NOT_FOUND', 'Contract not found'));
    if (!contract.disputeOpen) {
      throw new DomainException(appError('CONFLICT', 'There is no dispute to resolve'));
    }

    const held = { currency: contract.currency as 'BDT', minor: contract.heldMinor };
    const resolution = resolveDispute(held, outcome, toFreelancerMinor);
    if (!resolution.ok) this.refuse(resolution.error.code);

    await this.contracts.resolveDispute({
      contractId,
      outcome,
      toFreelancerMinor: resolution.value.toFreelancer.minor,
      currency: contract.currency,
      at: this.clock(),
    });

    // Read back without the party filter: support is not a party, so `isClient`/`isFreelancer`
    // are both false on the answer, which is exactly what the dispute desk should see.
    const after = await this.contracts.findForOperator(contractId);
    if (after === null) throw new DomainException(appError('NOT_FOUND', 'Contract not found'));
    return this.toContract(after, operator.accountId);
  }
}
