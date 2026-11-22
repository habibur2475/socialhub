'use client';

/**
 * One job, and everything that can happen to it.
 *
 * The page is three panels that appear according to **who is looking**:
 *
 *   * a freelancer, while the job is open, gets the bid form;
 *   * the client gets the proposals inbox, and the award form with its milestone plan;
 *   * whoever ends up with a contract gets a link to it.
 *
 * The buttons are not a client-side state machine. `isClient`, `hasProposed` and
 * `isAcceptingProposals` come from the server, and every action is a named request the server
 * may refuse in words this page then shows. A button that the API would always refuse is a bug,
 * and the flags exist so this component cannot invent one.
 *
 * The plan is filled in here, before the award is sent, because the award *is* the plan: a
 * milestone row that does not add up to the bid is refused, and this form says so as you type
 * rather than after a round trip.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BadgeCheck, Clock, FileSignature, Users } from 'lucide-react';

import {
  createJobRequestSchema,
  createProposalRequestSchema,
  type JobResponse,
  type ProposalResponse,
} from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { Field, Input } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createWorkApi } from '@/lib/work-api';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/time';

import {
  deadlineLabel,
  jobStatusLabel,
  priceLabel,
  proposalStatusLabel,
  workTone,
} from './vocabulary';

type Load = 'loading' | 'ready' | 'error';

type PlanLine = { readonly title: string; readonly amount: string };

/** Splits a bid into two equal halves that still add up, remainder on the last line. */
const defaultPlan = (bidMinor: number): PlanLine[] => {
  const first = Math.floor(bidMinor / 2);
  return [
    { title: 'First draft', amount: (first / 100).toFixed(2) },
    { title: 'Final delivery', amount: ((bidMinor - first) / 100).toFixed(2) },
  ];
};

export const JobDetail = ({ id }: { readonly id: string }): React.JSX.Element => {
  const { client: apiClient, status: sessionStatus } = useSession();

  const [job, setJob] = useState<JobResponse | null>(null);
  const [proposals, setProposals] = useState<readonly ProposalResponse[]>([]);
  const [load, setLoad] = useState<Load>('loading');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [bid, setBid] = useState('');
  const [coverLetter, setCoverLetter] = useState('');
  const [deliveryDays, setDeliveryDays] = useState('7');
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});

  /**
   * The plan is per *proposal*, not per job.
   *
   * The contract is for the accepted **bid**, and the kernel refuses a plan that does not add up
   * to it. A plan prefilled from the job's budget would therefore be wrong for every freelancer
   * who bid under budget — which, in a marketplace, is most of them. Choosing a proposal is what
   * creates a plan, and its halves come from that proposal's own number.
   */
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [plan, setPlan] = useState<readonly PlanLine[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    try {
      const found = await createWorkApi(apiClient).job(id);
      setJob(found);
      setBid((current) => (current === '' ? (found.budgetMinor / 100).toFixed(2) : current));
      setLoad('ready');

      if (found.isClient) {
        setProposals(await createWorkApi(apiClient).proposals(id));
      }
    } catch (cause) {
      setError(describeError(cause));
      setLoad('error');
    }
  }, [apiClient, id, sessionStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** The bid being planned for, or `null` while no proposal has been chosen. */
  const chosen = proposals.find((proposal) => proposal.id === chosenId) ?? null;
  const targetMinor = chosen?.bidMinor ?? null;

  const planMinor = useMemo(
    () =>
      plan.map((line) => {
        const parsed = createJobRequestSchema
          .pick({ budget: true })
          .safeParse({ budget: line.amount });
        return parsed.success ? parsed.data.budget : Number.NaN;
      }),
    [plan],
  );

  const planTotal = planMinor.reduce((sum, minor) => sum + minor, 0);
  const planAddsUp = targetMinor !== null && planTotal === targetMinor;

  const choose = (proposal: { readonly id: string; readonly bidMinor: number }): void => {
    setChosenId(proposal.id);
    setPlan(defaultPlan(proposal.bidMinor));
    setActionError(null);
  };

  const submitProposal = async (): Promise<void> => {
    if (busy) return;

    const parsed = createProposalRequestSchema.safeParse({
      bid,
      coverLetter,
      deliveryDays,
    });

    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues)
        next[issue.path.join('.') || '_form'] ??= issue.message;
      setIssues(next);
      return;
    }

    setIssues({});
    setBusy(true);
    setActionError(null);

    try {
      await createWorkApi(apiClient).propose(id, { bid, coverLetter, deliveryDays });
      await refresh();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (proposalId: string): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await createWorkApi(apiClient).withdraw(proposalId);
      await refresh();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const award = async (proposalId: string): Promise<void> => {
    if (job === null || !planAddsUp) return;

    setBusy(true);
    setActionError(null);
    try {
      await createWorkApi(apiClient).actOnJob(job.id, {
        action: 'AWARD',
        proposalId,
        milestones: plan.map((line) => ({ title: line.title, amount: line.amount })),
      });
      setChosenId(null);
      setPlan([]);
      await refresh();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    if (job === null) return;
    setBusy(true);
    setActionError(null);
    try {
      await createWorkApi(apiClient).actOnJob(job.id, { action: 'START' });
      await refresh();
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (load === 'loading') {
    return (
      <div className="flex flex-col gap-sm" aria-busy>
        <div className="skeleton h-8 w-56" />
        <div className="skeleton h-24 w-full" />
        <div className="skeleton h-24 w-full" />
      </div>
    );
  }

  if (load === 'error' || job === null) {
    return (
      <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-md">
        <p role="alert" className="text-body text-danger">
          {error ?? 'That job could not be loaded.'}
        </p>
        <Link href="/work" className={buttonClass('secondary', 'sm')}>
          <ArrowLeft aria-hidden className="size-4" />
          The board
        </Link>
      </div>
    );
  }

  const now = new Date();
  const myProposal = job.myProposal;

  return (
    <div className="flex flex-col gap-lg">
      <Link href="/work" className="flex items-center gap-xs text-small text-muted hover:text-text">
        <ArrowLeft aria-hidden className="size-4" />
        Work
      </Link>

      <header className="flex flex-col gap-xs">
        <div className="flex flex-wrap items-center gap-xs">
          <h1 className="text-heading">{job.title}</h1>
          <span className={cn('rounded-full px-[6px] py-[1px] text-caption', workTone(job.status))}>
            {jobStatusLabel[job.status]}
          </span>
        </div>
        <p className="flex flex-wrap items-center gap-xs text-small text-muted">
          <span className="font-medium text-text">{priceLabel(job.budgetMinor, job.currency)}</span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <Clock aria-hidden className="size-3.5" />
            {deadlineLabel(job.deadline, now)}
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <Users aria-hidden className="size-3.5" />
            {job.proposalCount} {job.proposalCount === 1 ? 'proposal' : 'proposals'}
          </span>
          <span aria-hidden>·</span>
          <span>{job.client.displayName}</span>
          <span aria-hidden>·</span>
          <span suppressHydrationWarning>posted {relativeTime(job.createdAt, now)}</span>
        </p>
      </header>

      <section className="flex flex-col gap-sm rounded-lg border border-border p-md">
        <h2 className="text-subheading">The brief</h2>
        <p className="whitespace-pre-line text-body text-muted">
          {job.description === '' ? 'The client wrote no description.' : job.description}
        </p>
      </section>

      {actionError === null ? null : (
        <p role="alert" className="text-body text-danger">
          {actionError}
        </p>
      )}

      {/* ---------------------------------------------------------------- the client's inbox */}
      {job.isClient && proposals.length > 0 ? (
        <section className="flex flex-col gap-sm">
          <h2 className="text-subheading">Proposals</h2>
          <p className="text-small text-muted">
            Hiring accepts one and closes the rest in the same moment. The contract is for the
            freelancer&rsquo;s own bid, split into milestones that must add up to it exactly.
          </p>

          <ul className="flex flex-col gap-sm">
            {proposals.map((proposal) => {
              const isChosen = proposal.id === chosenId;
              const canChoose = proposal.status === 'PENDING' && job.status === 'OPEN';

              return (
                <li
                  key={proposal.id}
                  className={cn(
                    'flex flex-col gap-xs rounded-lg border p-md',
                    isChosen ? 'border-primary/60 bg-primary/5' : 'border-border',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-xs">
                    <span className="text-body font-medium">{proposal.freelancer.displayName}</span>
                    <span className="text-caption text-muted">@{proposal.freelancer.username}</span>
                    <span className="ml-auto text-body font-semibold">
                      {priceLabel(proposal.bidMinor, proposal.currency)}
                    </span>
                  </div>
                  <p className="text-caption text-muted">
                    {proposal.deliveryDays} {proposal.deliveryDays === 1 ? 'day' : 'days'} from
                    acceptance · {proposalStatusLabel[proposal.status] ?? proposal.status}
                  </p>
                  <p className="whitespace-pre-line text-body">{proposal.coverLetter}</p>

                  {canChoose && !isChosen ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => choose(proposal)}
                      className={cn(buttonClass('secondary', 'sm'), 'self-start')}
                    >
                      Plan the milestones for {priceLabel(proposal.bidMinor, proposal.currency)}
                    </button>
                  ) : null}

                  {/* The plan belongs to one proposal, so it is rendered inside that row: the
                      number the client is splitting is the number they can see. */}
                  {isChosen ? (
                    <div className="mt-xs flex flex-col gap-xs rounded-md border border-border bg-surface p-sm">
                      <h3 className="text-small font-medium text-text">
                        Payment plan for {proposal.freelancer.displayName}
                      </h3>

                      {plan.map((line, index) => (
                        <div key={`line-${index}`} className="grid gap-xs sm:grid-cols-[1fr_140px]">
                          <Input
                            aria-label={`Milestone ${index + 1} title`}
                            value={line.title}
                            onChange={(event) =>
                              setPlan((current) =>
                                current.map((entry, at) =>
                                  at === index ? { ...entry, title: event.target.value } : entry,
                                ),
                              )
                            }
                          />
                          <Input
                            aria-label={`Milestone ${index + 1} amount`}
                            value={line.amount}
                            inputMode="decimal"
                            onChange={(event) =>
                              setPlan((current) =>
                                current.map((entry, at) =>
                                  at === index ? { ...entry, amount: event.target.value } : entry,
                                ),
                              )
                            }
                          />
                        </div>
                      ))}

                      <p
                        className={cn('text-caption', planAddsUp ? 'text-success' : 'text-danger')}
                        role={planAddsUp ? undefined : 'alert'}
                      >
                        {planAddsUp
                          ? `The plan adds up to the bid of ${priceLabel(proposal.bidMinor, proposal.currency)}.`
                          : Number.isNaN(planTotal)
                            ? 'Each milestone needs a plain amount, like 250 or 250.50.'
                            : `The plan adds up to ${priceLabel(planTotal, proposal.currency)}, but the bid is ${priceLabel(proposal.bidMinor, proposal.currency)}.`}
                      </p>

                      <div className="flex flex-wrap items-center gap-xs">
                        <button
                          type="button"
                          disabled={busy || !planAddsUp}
                          onClick={() => void award(proposal.id)}
                          className={buttonClass('primary', 'sm')}
                        >
                          <BadgeCheck aria-hidden className="size-4" />
                          {busy ? 'Hiring…' : 'Hire and fund the escrow'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setChosenId(null);
                            setPlan([]);
                          }}
                          className={buttonClass('ghost', 'sm')}
                        >
                          Choose someone else
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* ------------------------------------------------------------ the freelancer's side */}
      {!job.isClient && myProposal !== null ? (
        <section className="flex flex-col gap-sm rounded-lg border border-border p-md">
          <h2 className="text-subheading">Your proposal</h2>
          <p className="text-small text-muted">
            {priceLabel(myProposal.bidMinor, myProposal.currency)} · {myProposal.deliveryDays}{' '}
            {myProposal.deliveryDays === 1 ? 'day' : 'days'} ·{' '}
            {proposalStatusLabel[myProposal.status] ?? myProposal.status}
          </p>
          <p className="whitespace-pre-line text-body">{myProposal.coverLetter}</p>

          {myProposal.status === 'PENDING' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void withdraw(myProposal.id)}
              className={cn(buttonClass('secondary', 'sm'), 'self-start')}
            >
              Withdraw
            </button>
          ) : null}
        </section>
      ) : null}

      {!job.isClient && myProposal === null && job.isAcceptingProposals ? (
        <section className="flex flex-col gap-md">
          <h2 className="text-subheading">Send a proposal</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitProposal();
            }}
            className="flex flex-col gap-md"
          >
            <div className="grid gap-md sm:grid-cols-2">
              <Field
                label="Your price"
                htmlFor="proposal-bid"
                required
                hint={`At or below ${priceLabel(job.budgetMinor, job.currency)}`}
                {...(issues['bid'] === undefined ? {} : { error: issues['bid'] })}
              >
                <Input
                  id="proposal-bid"
                  value={bid}
                  inputMode="decimal"
                  onChange={(event) => setBid(event.target.value)}
                  required
                />
              </Field>

              <Field
                label="Days to deliver"
                htmlFor="proposal-days"
                required
                {...(issues['deliveryDays'] === undefined ? {} : { error: issues['deliveryDays'] })}
              >
                <Input
                  id="proposal-days"
                  value={deliveryDays}
                  inputMode="numeric"
                  onChange={(event) => setDeliveryDays(event.target.value)}
                  required
                />
              </Field>
            </div>

            <Field
              label="Why you"
              htmlFor="proposal-letter"
              required
              hint="Twenty characters at least — one sentence about similar work is enough"
              {...(issues['coverLetter'] === undefined ? {} : { error: issues['coverLetter'] })}
            >
              <textarea
                id="proposal-letter"
                value={coverLetter}
                onChange={(event) => setCoverLetter(event.target.value)}
                rows={5}
                maxLength={4_000}
                className="resize-y rounded-md border border-border-strong/40 bg-surface p-sm text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              />
            </Field>

            <button
              type="submit"
              disabled={busy || sessionStatus !== 'authenticated'}
              className={cn(buttonClass('primary', 'md'), 'self-start')}
            >
              {busy ? 'Sending…' : 'Send proposal'}
            </button>
          </form>
        </section>
      ) : null}

      {/* ------------------------------------------------------------- the hired freelancer */}
      {!job.isClient && job.status === 'ASSIGNED' ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void start()}
          className={cn(buttonClass('primary', 'md'), 'self-start')}
        >
          Start work
        </button>
      ) : null}

      {job.status === 'ASSIGNED' || job.status === 'IN_PROGRESS' || job.status === 'COMPLETED' ? (
        <Link
          href={`/work/contracts?job=${job.id}`}
          className={cn(buttonClass('secondary', 'md'), 'self-start')}
        >
          <FileSignature aria-hidden className="size-4" />
          Go to the contract
        </Link>
      ) : null}
    </div>
  );
};
