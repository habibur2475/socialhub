/**
 * The words a work screen uses.
 *
 * Every status and every action has a human label here, and the labels are the ones a client or
 * a freelancer would use — "Accepting proposals", not "OPEN". A raw enum on a screen is a bug
 * this file exists to prevent, so the tests assert a label for each member of each list.
 *
 * The money helpers are shared with the market rather than re-implemented: a taka is a taka,
 * and a second decimal point is a second opinion.
 */

import type { JobAction, JobStatus, MilestoneAction, MilestoneStatus } from '@socialhub/contracts';

export { formatPrice, priceLabel } from '@/components/market/money';

export const jobStatusLabel: Readonly<Record<JobStatus, string>> = {
  DRAFT: 'Not published',
  OPEN: 'Accepting proposals',
  ASSIGNED: 'Freelancer chosen',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const proposalStatusLabel: Readonly<Record<string, string>> = {
  PENDING: 'Waiting for an answer',
  ACCEPTED: 'Accepted',
  REJECTED: 'Not chosen',
  WITHDRAWN: 'Withdrawn',
};

export const milestoneStatusLabel: Readonly<Record<MilestoneStatus, string>> = {
  PLANNED: 'Not funded',
  FUNDED: 'In escrow',
  SUBMITTED: 'Delivered, awaiting review',
  RELEASED: 'Paid out',
};

export const contractStatusLabel: Readonly<Record<string, string>> = {
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  DISPUTED: 'In dispute',
};

export const jobActionLabel: Readonly<Record<JobAction, string>> = {
  AWARD: 'Hire this freelancer',
  START: 'Start work',
  COMPLETE: 'Mark as complete',
  CANCEL: 'Cancel job',
};

export const milestoneActionLabel: Readonly<Record<MilestoneAction, string>> = {
  FUND: 'Fund this milestone',
  SUBMIT: 'Deliver this milestone',
  APPROVE: 'Approve and pay',
};

/**
 * One palette for the whole module: green is settled, amber is waiting on somebody, grey is
 * over. The same colour means the same thing on a job row and on a contract.
 */
export const workTone = (status: string): string => {
  switch (status) {
    case 'COMPLETED':
    case 'RELEASED':
      return 'bg-success/10 text-success';
    case 'OPEN':
    case 'IN_PROGRESS':
    case 'ACTIVE':
    case 'FUNDED':
      return 'bg-primary/10 text-primary';
    case 'ASSIGNED':
    case 'SUBMITTED':
    case 'PENDING':
      return 'bg-warning/10 text-warning';
    case 'DISPUTED':
      return 'bg-danger/10 text-danger';
    case 'DRAFT':
    case 'CANCELLED':
    case 'REJECTED':
    case 'WITHDRAWN':
    case 'PLANNED':
    default:
      return 'bg-raised text-muted';
  }
};

/**
 * How a deadline reads.
 *
 * Days, not dates, while it is near: "3 days left" is the number a freelancer needs, and
 * "27 Nov" is the one they need a week later. Past the deadline the answer is not a countdown
 * but a fact.
 *
 * The count is **whole days remaining**, floored, with everything under a day reading as "Due
 * today". Rounding up would say "1 day left" about a deadline two hours away, which is the one
 * place this label could mislead somebody into starting work they cannot finish.
 */
export const deadlineLabel = (deadline: string, now: Date = new Date()): string => {
  const end = new Date(deadline).getTime();
  if (Number.isNaN(end)) return 'No deadline';

  const dayMs = 86_400_000;
  const remaining = end - now.getTime();

  if (remaining <= 0) return 'Deadline passed';
  if (remaining < dayMs) return 'Due today';

  const days = Math.floor(remaining / dayMs);
  if (days === 1) return '1 day left';
  if (days <= 14) return `${days} days left`;

  return new Date(deadline).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

/** Whether a job can still take proposals, from the client's side of the same rule. */
export const isOpenForProposals = (
  status: string,
  deadline: string,
  now: Date = new Date(),
): boolean => status === 'OPEN' && new Date(deadline).getTime() > now.getTime();
