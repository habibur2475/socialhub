/**
 * Work service rules.
 *
 * The kernel already proves the state machines, the plan arithmetic and the fee split. What is
 * tested here is the part only the service can get wrong:
 *
 *   * **who is asking** — an award by a stranger, a proposal on your own job, a freelancer
 *     reading the client's inbox;
 *   * **the order of the checks** — a plan that does not add up must be refused *before* the
 *     award is written, or the job is left filled and unpaid;
 *   * **what the contract is for** — the accepted bid, not the advertised budget;
 *   * **the money that leaves** — the fee and the net, and the dispute that freezes both;
 *   * **what each side is offered** — the buttons a contract row shows.
 */

import { describe, expect, it, vi } from 'vitest';

import { WorkService } from './work.service.js';
import type {
  AwardOutcome,
  ContractRecord,
  ContractStore,
  JobRecord,
  JobStore,
  MilestoneRecord,
  ProposalRecord,
  ProposalStore,
} from './ports.js';

const CLIENT = '0190f3c1-0000-7000-8000-00000000000a';
const FREELANCER = '0190f3c1-0000-7000-8000-00000000000b';
const STRANGER = '0190f3c1-0000-7000-8000-00000000000c';
const NOW = new Date('2026-11-21T10:00:00.000Z');
const SOON = new Date('2026-12-01T00:00:00.000Z');
const LATER = new Date('2026-12-20T00:00:00.000Z');

const job = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  id: '0190f3c1-0000-7000-8000-0000000000d1',
  clientId: CLIENT,
  client: { accountId: CLIENT, username: 'ada', displayName: 'Ada', avatarKey: null },
  title: 'Write the launch announcement',
  description: 'Two paragraphs, plain English.',
  category: 'writing',
  budgetMinor: 60_000,
  currency: 'BDT',
  status: 'OPEN',
  deadline: SOON,
  assignedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const proposal = (overrides: Partial<ProposalRecord> = {}): ProposalRecord => ({
  id: '0190f3c1-0000-7000-8000-0000000000e1',
  jobId: job().id,
  freelancerId: FREELANCER,
  freelancer: { accountId: FREELANCER, username: 'grace', displayName: 'Grace', avatarKey: null },
  bidMinor: 60_000,
  currency: 'BDT',
  coverLetter: 'I have written four launch posts this year and I can send samples.',
  deliveryDays: 5,
  status: 'PENDING',
  createdAt: NOW,
  ...overrides,
});

const milestone = (overrides: Partial<MilestoneRecord> = {}): MilestoneRecord => ({
  id: '0190f3c1-0000-7000-8000-0000000000f1',
  contractId: '0190f3c1-0000-7000-8000-0000000000a1',
  position: 1,
  title: 'First draft',
  amountMinor: 30_000,
  status: 'SUBMITTED',
  submittedAt: NOW,
  releasedAt: null,
  ...overrides,
});

const contract = (overrides: Partial<ContractRecord> = {}): ContractRecord => ({
  id: '0190f3c1-0000-7000-8000-0000000000a1',
  jobId: job().id,
  jobTitle: job().title,
  clientId: CLIENT,
  freelancerId: FREELANCER,
  client: { accountId: CLIENT, username: 'ada', displayName: 'Ada', avatarKey: null },
  freelancer: { accountId: FREELANCER, username: 'grace', displayName: 'Grace', avatarKey: null },
  amountMinor: 60_000,
  currency: 'BDT',
  status: 'ACTIVE',
  disputeOpen: false,
  milestones: [
    milestone(),
    milestone({
      id: '0190f3c1-0000-7000-8000-0000000000f2',
      position: 2,
      title: 'Final',
      amountMinor: 30_000,
      status: 'FUNDED',
      submittedAt: null,
    }),
  ],
  heldMinor: 60_000,
  releasedMinor: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const createService = (
  options: {
    readonly jobs?: readonly JobRecord[];
    readonly proposals?: () => readonly ProposalRecord[];
    readonly award?: AwardOutcome | null;
    readonly contract?: ContractRecord;
    readonly moved?: boolean;
  } = {},
) => {
  const board = new Map((options.jobs ?? [job()]).map((entry) => [entry.id, entry] as const));
  const proposalList = (): readonly ProposalRecord[] =>
    options.proposals === undefined ? [proposal()] : options.proposals();

  const jobStore = {
    list: vi.fn(async () => ({
      items: [...board.values()].map((entry) => ({
        job: entry,
        proposalCount: 1,
        viewerProposed: false,
      })),
    })),
    find: vi.fn(async (viewerId: string, id: string) => {
      const found = board.get(id);
      if (found === undefined) return null;
      if (found.status === 'DRAFT' && found.clientId !== viewerId) return null;
      return {
        job: found,
        proposalCount: proposalList().filter((entry) => entry.jobId === id).length,
        viewerProposed: proposalList().some(
          (entry) =>
            entry.jobId === id && entry.freelancerId === viewerId && entry.status !== 'WITHDRAWN',
        ),
      };
    }),
    create: vi.fn(async (record: JobRecord) => {
      board.set(record.id, record);
      return record;
    }),
    update: vi.fn(async (_clientId: string, id: string, patch: Partial<JobRecord>) => {
      const found = board.get(id);
      if (found === undefined) return null;
      const next = { ...found, ...patch };
      board.set(id, next);
      return next;
    }),
  } satisfies JobStore;

  const proposalStore = {
    listForJob: vi.fn(async () => proposalList()),
    find: vi.fn(async () => proposalList()[0] ?? null),
    create: vi.fn(async (record: ProposalRecord) => record),
    award: vi.fn(async () =>
      'award' in options
        ? options.award
        : { kind: 'AWARDED' as const, accepted: proposal(), rejected: 2 },
    ),
    withdraw: vi.fn(async () => true),
  } satisfies ProposalStore;

  const contractStore = {
    list: vi.fn(async () => ({ items: [options.contract ?? contract()] })),
    find: vi.fn(async (viewerId: string) => {
      const found = options.contract ?? contract();
      return found.clientId === viewerId || found.freelancerId === viewerId ? found : null;
    }),
    findForOperator: vi.fn(async () => options.contract ?? contract()),
    create: vi.fn(async () => options.contract ?? contract()),
    setStatus: vi.fn(async () => undefined),
    moveMilestone: vi.fn(async () => options.moved ?? true),
    openDispute: vi.fn(async () => true),
    resolveDispute: vi.fn(async () => undefined),
  } satisfies ContractStore;

  const service = new WorkService(
    jobStore,
    proposalStore,
    contractStore,
    { next: () => '0190f3c1-0000-7000-8000-0000000000ff' },
    () => NOW,
  );

  return { service, jobStore, proposalStore, contractStore };
};

const refusal = async (promise: Promise<unknown>, message: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ error: { message } });
};

describe('the board', () => {
  it('stops calling a job open once its deadline has passed', async () => {
    const { service } = createService({
      jobs: [job({ deadline: new Date('2026-11-20T00:00:00Z') })],
    });
    const [summary] = (await service.listJobs(STRANGER, { openOnly: false } as never)).items;

    // The status column still says OPEN; whether it is *actually* open is a fact about time.
    expect(summary).toMatchObject({ status: 'OPEN', isAcceptingProposals: false });
  });

  it('hides a draft from everyone but its client', async () => {
    const { service, jobStore } = createService({ jobs: [job({ status: 'DRAFT' })] });

    await expect(service.job(STRANGER, job().id)).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(jobStore.find).toHaveBeenCalledWith(STRANGER, job().id);

    await expect(service.job(CLIENT, job().id)).resolves.toMatchObject({ status: 'DRAFT' });
  });

  it('refuses a deadline in the past, in words a person can act on', async () => {
    const { service } = createService();
    await refusal(
      service.createJob(CLIENT, {
        title: 'Write the launch announcement',
        description: '',
        category: 'writing',
        budget: 50_000,
        currency: 'BDT',
        deadline: '2026-11-01T00:00:00.000Z',
        status: 'OPEN',
      }),
      'The deadline has already passed',
    );
  });

  it('does not disclose whose job it is when a stranger edits it', async () => {
    const { service } = createService();
    // `404`, not `403`: the same answer a job that never existed returns.
    await expect(
      service.updateJob(STRANGER, job().id, { title: 'Something else entirely' }),
    ).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('proposals', () => {
  it('refuses a bid above the advertised budget, and says nothing was recorded', async () => {
    const { service, proposalStore } = createService({ proposals: () => [] });

    await refusal(
      service.propose(FREELANCER, job().id, {
        bid: 90_000,
        coverLetter: 'I can do this in a week, here are three samples.',
        deliveryDays: 7,
      }),
      'Your bid is above the budget the client posted',
    );
    expect(proposalStore.create).not.toHaveBeenCalled();
  });

  it('refuses the client proposing on their own job', async () => {
    const { service } = createService({ proposals: () => [] });

    await refusal(
      service.propose(CLIENT, job().id, {
        bid: 60_000,
        coverLetter: 'I will do it myself, which saves everyone time.',
        deliveryDays: 5,
      }),
      'You cannot propose on your own job',
    );
  });

  it('refuses a second live proposal but allows one after a withdrawal', async () => {
    const settled = createService({ proposals: () => [proposal()] });
    await refusal(
      settled.service.propose(FREELANCER, job().id, {
        bid: 60_000,
        coverLetter: 'A second pitch, which should not be needed.',
        deliveryDays: 5,
      }),
      'You already have a proposal on this job',
    );

    const withdrawn = createService({ proposals: () => [proposal({ status: 'WITHDRAWN' })] });
    await expect(
      withdrawn.service.propose(FREELANCER, job().id, {
        bid: 55_000,
        coverLetter: 'Coming back with a sharper price and a shorter promise.',
        deliveryDays: 4,
      }),
    ).resolves.toMatchObject({ bidMinor: 55_000, status: 'PENDING' });
  });

  it('keeps the proposal list to the client', async () => {
    const { service } = createService();

    await expect(service.proposalsForJob(CLIENT, job().id)).resolves.toHaveLength(1);
    await expect(service.proposalsForJob(FREELANCER, job().id)).rejects.toMatchObject({
      error: { code: 'FORBIDDEN' },
    });
  });
});

describe('the award', () => {
  it('refuses a plan that does not add up, before anything is written', async () => {
    const { service, proposalStore, contractStore } = createService();

    await refusal(
      service.actOnJob(CLIENT, job().id, {
        action: 'AWARD',
        proposalId: proposal().id,
        milestones: [
          { title: 'First draft', amount: 30_000 },
          { title: 'Final', amount: 20_000 },
        ],
      }),
      'The milestones must add up to the agreed amount',
    );

    // The whole point: no award, no contract. A job that is filled but unpaid is worse than
    // a job that is still open.
    expect(proposalStore.award).not.toHaveBeenCalled();
    expect(contractStore.create).not.toHaveBeenCalled();
  });

  it('closes the job and creates the contract for the bid, not the budget', async () => {
    const bid = proposal({ bidMinor: 45_000 });
    const { service, proposalStore, contractStore } = createService({ proposals: () => [bid] });

    await service.actOnJob(CLIENT, job().id, {
      action: 'AWARD',
      proposalId: bid.id,
      milestones: [
        { title: 'First draft', amount: 20_000 },
        { title: 'Final', amount: 25_000 },
      ],
    });

    expect(proposalStore.award).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job().id, proposalId: bid.id, at: NOW }),
    );
    expect(contractStore.create).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 45_000, freelancerId: FREELANCER, clientId: CLIENT }),
    );
  });

  it('will not let a stranger award a job', async () => {
    const { service, proposalStore } = createService();
    await expect(
      service.actOnJob(STRANGER, job().id, {
        action: 'AWARD',
        proposalId: proposal().id,
        milestones: [{ title: 'Everything', amount: 60_000 }],
      }),
    ).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(proposalStore.award).not.toHaveBeenCalled();
  });

  it('lets the hired freelancer start, and nobody else', async () => {
    const hired = job({ status: 'ASSIGNED' });
    const accepted = proposal({ status: 'ACCEPTED' });
    const { service } = createService({ jobs: [hired], proposals: () => [accepted] });

    // The stranger first: starting the job moves it out of `ASSIGNED`, and the stub store keeps
    // that move, so the second call would be refused for the wrong reason.
    await expect(service.actOnJob(STRANGER, hired.id, { action: 'START' })).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });

    await expect(
      service.actOnJob(FREELANCER, hired.id, { action: 'START' }),
    ).resolves.toMatchObject({ job: { status: 'IN_PROGRESS' } });
  });

  it('refuses to start a job that has not been awarded', async () => {
    const { service } = createService({ proposals: () => [] });
    await refusal(
      service.actOnJob(FREELANCER, job().id, { action: 'START' }),
      'That is not something you can do to this job yet',
    );
  });
});

describe('the contract', () => {
  it('offers the freelancer a submit and the client an approval, not both at once', async () => {
    const { service } = createService();

    const byClient = await service.contract(CLIENT, contract().id);
    const byFreelancer = await service.contract(FREELANCER, contract().id);

    // Milestone 1 is delivered, so the client can approve it. Milestone 2 is funded, so the
    // freelancer can submit it. Each side sees only its own move, which is why the UI never
    // offers a button that the API would refuse.
    expect(byClient.availableActions).toEqual(['APPROVE']);
    expect(byFreelancer.availableActions).toEqual(['SUBMIT']);

    const awaitingApproval = contract({
      milestones: [
        milestone({ status: 'SUBMITTED' }),
        milestone({
          id: '0190f3c1-0000-7000-8000-0000000000f2',
          position: 2,
          title: 'Final',
          amountMinor: 30_000,
          status: 'FUNDED',
          submittedAt: null,
        }),
      ],
    });
    const perRole = createService({ contract: awaitingApproval });
    expect((await perRole.service.contract(CLIENT, awaitingApproval.id)).availableActions).toEqual([
      'APPROVE',
    ]);
    expect(
      (await perRole.service.contract(FREELANCER, awaitingApproval.id)).availableActions,
    ).toEqual(['SUBMIT']);
  });

  it('splits a release into the fee and the net, and 5% leaves the freelancer 95%', async () => {
    const { service, contractStore } = createService();

    await service.actOnMilestone(CLIENT, contract().id, milestone().id, { action: 'APPROVE' });

    expect(contractStore.moveMilestone).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'SUBMITTED',
        to: 'RELEASED',
        escrow: { feeMinor: 1_500, netMinor: 28_500 },
      }),
    );
  });

  it('refuses an approval while a dispute is open', async () => {
    const disputed = contract({ disputeOpen: true, status: 'DISPUTED' });
    const { service, contractStore } = createService({ contract: disputed });

    await refusal(
      service.actOnMilestone(CLIENT, disputed.id, milestone().id, { action: 'APPROVE' }),
      'The money is frozen while the dispute is open',
    );
    expect(contractStore.moveMilestone).not.toHaveBeenCalled();
  });

  it('reports a lost race as a conflict rather than paying twice', async () => {
    const { service } = createService({ moved: false });
    await expect(
      service.actOnMilestone(CLIENT, contract().id, milestone().id, { action: 'APPROVE' }),
    ).rejects.toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('refuses a milestone the caller is not a party to', async () => {
    const { service } = createService();
    await expect(
      service.actOnMilestone(STRANGER, contract().id, milestone().id, { action: 'APPROVE' }),
    ).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('keeps the dispute desk to support', async () => {
    const disputed = contract({ disputeOpen: true, status: 'DISPUTED' });
    const { service, contractStore } = createService({ contract: disputed });

    await expect(
      service.resolve(
        { accountId: CLIENT, accountType: 'USER' },
        disputed.id,
        'REFUNDED_TO_CLIENT',
      ),
    ).rejects.toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(contractStore.resolveDispute).not.toHaveBeenCalled();

    await service.resolve(
      { accountId: STRANGER, accountType: 'STAFF' },
      disputed.id,
      'REFUNDED_TO_CLIENT',
    );
    expect(contractStore.resolveDispute).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'REFUNDED_TO_CLIENT', toFreelancerMinor: 0 }),
    );
  });

  it('refuses a split larger than the escrow holds', async () => {
    const disputed = contract({ disputeOpen: true, status: 'DISPUTED' });
    const { service } = createService({ contract: disputed });

    await refusal(
      service.resolve(
        { accountId: STRANGER, accountType: 'STAFF' },
        disputed.id,
        'RELEASED_TO_FREELANCER',
        60_001,
      ),
      'The milestones must add up to the agreed amount',
    );
  });
});
