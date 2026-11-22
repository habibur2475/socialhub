'use client';

/**
 * One contract: the plan, the escrow, and the two buttons that actually move money.
 *
 * Every button comes from `availableActions` on the server. This page does not know the state
 * machine; it knows that if the API did not offer an action, showing it would mean showing a
 * button that is refused. The one thing this component does decide is which **milestone** the
 * action belongs to — the action list is per contract, because it is the same three verbs no
 * matter how many milestones there are.
 *
 * "Approve and pay" releases money, so it asks first. Everything else is reversible enough to
 * press without a dialogue, and a confirmation on every step teaches people to dismiss dialogues.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Lock, Scale, ShieldCheck } from 'lucide-react';

import type { ContractResponse, MilestoneAction, MilestoneResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createWorkApi } from '@/lib/work-api';
import { useSession } from '@/lib/session';

import {
  contractStatusLabel,
  milestoneActionLabel,
  milestoneStatusLabel,
  priceLabel,
  workTone,
} from './vocabulary';

type Load = 'loading' | 'ready' | 'error';

/** Which action applies to this milestone, if any — the same list the server sends. */
const actionFor = (
  milestone: MilestoneResponse,
  available: readonly MilestoneAction[],
): MilestoneAction | null => {
  if (milestone.status === 'PLANNED' && available.includes('FUND')) return 'FUND';
  if (milestone.status === 'FUNDED' && available.includes('SUBMIT')) return 'SUBMIT';
  if (milestone.status === 'SUBMITTED' && available.includes('APPROVE')) return 'APPROVE';
  return null;
};

export const ContractView = ({ id }: { readonly id: string }): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();

  const [contract, setContract] = useState<ContractResponse | null>(null);
  const [load, setLoad] = useState<Load>('loading');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    try {
      setContract(await createWorkApi(client).contract(id));
      setLoad('ready');
    } catch (cause) {
      setError(describeError(cause));
      setLoad('error');
    }
  }, [client, id, sessionStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (milestone: MilestoneResponse, action: MilestoneAction): Promise<void> => {
    if (busy !== null) return;

    if (
      action === 'APPROVE' &&
      !window.confirm(
        `Approve “${milestone.title}”? ${priceLabel(milestone.amountMinor, contract?.currency ?? 'BDT')} leaves escrow now.`,
      )
    ) {
      return;
    }

    setBusy(milestone.id);
    setActionError(null);
    try {
      setContract(await createWorkApi(client).actOnMilestone(id, milestone.id, { action }));
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  const openDispute = async (): Promise<void> => {
    if (busy !== null || reason.trim().length < 10) return;

    setBusy('dispute');
    setActionError(null);
    try {
      setContract(await createWorkApi(client).dispute(id, reason.trim()));
      setDisputing(false);
      setReason('');
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setBusy(null);
    }
  };

  if (load === 'loading') {
    return (
      <div className="flex flex-col gap-sm" aria-busy>
        <div className="skeleton h-8 w-56" />
        <div className="skeleton h-32 w-full" />
      </div>
    );
  }

  if (load === 'error' || contract === null) {
    return (
      <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-md">
        <p role="alert" className="text-body text-danger">
          {error ?? 'That contract could not be loaded.'}
        </p>
        <Link href="/work/contracts" className={buttonClass('secondary', 'sm')}>
          <ArrowLeft aria-hidden className="size-4" />
          All contracts
        </Link>
      </div>
    );
  }

  const counterparty = contract.isClient ? contract.freelancer : contract.client;
  const paid = contract.milestones.filter((milestone) => milestone.status === 'RELEASED').length;
  // The last released milestone closes the contract; a dispute is the only other way out.
  const canDispute =
    !contract.disputeOpen && contract.status === 'ACTIVE' && contract.heldMinor > 0;

  return (
    <div className="flex flex-col gap-lg">
      <Link
        href="/work/contracts"
        className="flex items-center gap-xs text-small text-muted hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Contracts
      </Link>

      <header className="flex flex-col gap-xs">
        <div className="flex flex-wrap items-center gap-xs">
          <h1 className="text-heading">{contract.jobTitle}</h1>
          <span
            className={cn('rounded-full px-[6px] py-[1px] text-caption', workTone(contract.status))}
          >
            {contractStatusLabel[contract.status] ?? contract.status}
          </span>
        </div>
        <p className="text-small text-muted">
          {contract.isClient ? 'Freelancer' : 'Client'}{' '}
          <span className="text-text">{counterparty.displayName}</span>
          {' · '}
          {paid} of {contract.milestones.length} milestones paid
        </p>
      </header>

      <section className="grid gap-sm sm:grid-cols-3">
        <div className="flex flex-col gap-[2px] rounded-lg border border-border p-md">
          <span className="text-caption text-muted">Contract value</span>
          <span className="text-body font-semibold">
            {priceLabel(contract.amountMinor, contract.currency)}
          </span>
        </div>
        <div className="flex flex-col gap-[2px] rounded-lg border border-border p-md">
          <span className="flex items-center gap-1 text-caption text-muted">
            <Lock aria-hidden className="size-3.5" />
            Still in escrow
          </span>
          <span className="text-body font-semibold">
            {priceLabel(contract.heldMinor, contract.currency)}
          </span>
        </div>
        <div className="flex flex-col gap-[2px] rounded-lg border border-border p-md">
          <span className="flex items-center gap-1 text-caption text-muted">
            <ShieldCheck aria-hidden className="size-3.5" />
            Released
          </span>
          <span className="text-body font-semibold">
            {priceLabel(contract.releasedMinor, contract.currency)}
          </span>
        </div>
      </section>

      {actionError === null ? null : (
        <p role="alert" className="text-body text-danger">
          {actionError}
        </p>
      )}

      {contract.disputeOpen ? (
        <p className="flex items-start gap-xs rounded-lg border border-border p-md text-small text-danger">
          <Scale aria-hidden className="mt-[1px] size-4 shrink-0" />A dispute is open. The money is
          frozen until support resolves it, and neither side can release it in the meantime.
        </p>
      ) : null}

      <section className="flex flex-col gap-sm">
        <h2 className="text-subheading">Payment plan</h2>

        <ol className="flex flex-col gap-sm">
          {contract.milestones.map((milestone) => {
            const action = actionFor(milestone, contract.availableActions);

            return (
              <li
                key={milestone.id}
                className="flex flex-col gap-xs rounded-lg border border-border p-md"
              >
                <div className="flex flex-wrap items-center gap-xs">
                  <span className="text-caption text-muted">{milestone.position}</span>
                  <span className="text-body font-medium">{milestone.title}</span>
                  <span className="ml-auto text-body font-semibold">
                    {priceLabel(milestone.amountMinor, contract.currency)}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-xs">
                  <span
                    className={cn(
                      'rounded-full px-[6px] py-[1px] text-caption',
                      workTone(milestone.status),
                    )}
                  >
                    {milestoneStatusLabel[milestone.status]}
                  </span>

                  {action === null ? null : (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void act(milestone, action)}
                      className={cn(
                        buttonClass(action === 'APPROVE' ? 'primary' : 'secondary', 'sm'),
                        'ml-auto',
                      )}
                    >
                      {busy === milestone.id ? 'Working…' : milestoneActionLabel[action]}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {canDispute ? (
        <section className="flex flex-col gap-sm border-t border-border pt-md">
          {disputing ? (
            <>
              <label htmlFor="dispute-reason" className="text-small font-medium text-text">
                What went wrong?
              </label>
              <textarea
                id="dispute-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={4}
                maxLength={2_000}
                className="resize-y rounded-md border border-border-strong/40 bg-surface p-sm text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                placeholder="Support reads this. Say what was agreed and what happened."
              />
              <div className="flex flex-wrap items-center gap-sm">
                <button
                  type="button"
                  disabled={busy !== null || reason.trim().length < 10}
                  onClick={() => void openDispute()}
                  className={buttonClass('danger', 'sm')}
                >
                  {busy === 'dispute' ? 'Opening…' : 'Open a dispute'}
                </button>
                <button
                  type="button"
                  onClick={() => setDisputing(false)}
                  className={buttonClass('ghost', 'sm')}
                >
                  Never mind
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setDisputing(true)}
              className="self-start text-small font-medium text-danger underline"
            >
              Something went wrong — open a dispute
            </button>
          )}
        </section>
      ) : null}
    </div>
  );
};
