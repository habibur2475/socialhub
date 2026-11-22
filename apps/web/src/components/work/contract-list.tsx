'use client';

/**
 * Contracts: every agreement the viewer is party to.
 *
 * One list, not two tabs. A contract has exactly two parties and the viewer is one of them, so
 * "contracts I am working on" and "contracts somebody is working on for me" are the same rows
 * read from different sides — `isClient` decides which name to show, not which endpoint to call.
 *
 * The escrow column is the held amount, which is what a contract is: money that has been paid
 * and not yet released.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { FileSignature } from 'lucide-react';

import type { ContractResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createWorkApi } from '@/lib/work-api';
import { useSession } from '@/lib/session';

import { contractStatusLabel, priceLabel, workTone } from './vocabulary';

type Load = 'loading' | 'ready' | 'error';

export const ContractList = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();

  const [contracts, setContracts] = useState<readonly ContractResponse[]>([]);
  const [load, setLoad] = useState<Load>('loading');
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setLoad('loading');
    setError(null);
    try {
      const page = await createWorkApi(client).contracts();
      setContracts(page.items);
      setLoad('ready');
    } catch (cause) {
      setError(describeError(cause));
      setLoad('error');
    }
  }, [client, sessionStatus]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return (
    <div className="flex flex-col gap-lg">
      {load === 'loading' ? (
        <div className="flex flex-col gap-sm" aria-busy>
          {[0, 1].map((key) => (
            <div key={key} className="rounded-lg border border-border p-md">
              <div className="skeleton h-5 w-48" />
              <div className="skeleton mt-xs h-4 w-32" />
            </div>
          ))}
        </div>
      ) : null}

      {load === 'error' ? (
        <div className="flex flex-col gap-sm rounded-lg border border-border p-md">
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
          <button
            type="button"
            onClick={() => void fetch()}
            className="self-start text-small font-medium text-primary underline"
          >
            Try again
          </button>
        </div>
      ) : null}

      {load === 'ready' && contracts.length === 0 ? (
        <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-lg">
          <FileSignature aria-hidden className="size-6 text-muted" />
          <p className="text-body text-muted">
            No contracts yet. One appears here the moment a job is awarded — with the money already
            in escrow, and the milestones waiting for work.
          </p>
          <Link href="/work" className={buttonClass('primary', 'sm')}>
            Browse work
          </Link>
        </div>
      ) : null}

      <ul className="flex flex-col gap-sm">
        {contracts.map((contract) => {
          const counterparty = contract.isClient ? contract.freelancer : contract.client;
          const done = contract.milestones.filter(
            (milestone) => milestone.status === 'RELEASED',
          ).length;

          return (
            <li key={contract.id}>
              <Link
                href={`/work/contracts/${contract.id}`}
                className="flex flex-col gap-xs rounded-lg border border-border p-md transition-colors hover:border-primary/50"
              >
                <span className="flex flex-wrap items-center gap-xs">
                  <span className="text-body font-medium">{contract.jobTitle}</span>
                  <span
                    className={cn(
                      'ml-auto rounded-full px-[6px] py-[1px] text-caption',
                      workTone(contract.status),
                    )}
                  >
                    {contractStatusLabel[contract.status] ?? contract.status}
                  </span>
                </span>

                <span className="flex flex-wrap items-center gap-xs text-caption text-muted">
                  <span>
                    {contract.isClient ? 'Hired' : 'Working for'} {counterparty.displayName}
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    {done} of {contract.milestones.length} milestones paid
                  </span>
                  <span aria-hidden>·</span>
                  <span className="font-medium text-text">
                    {priceLabel(contract.heldMinor, contract.currency)} in escrow
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
