'use client';

/**
 * One order.
 *
 * The buttons are `availableActions` from the server, not a client-side state table. The
 * state machine lives in the kernel and the actor is derived from who is asking, so a button
 * this component invented would either be refused or, worse, be offered to the wrong party.
 *
 * The timeline is the stored history: every row is a move somebody made, with the party and
 * the time. An order with a gap in its history is a bug the reader can see.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, MapPin } from 'lucide-react';

import type { OrderAction, OrderResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createMarketApi } from '@/lib/market-api';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/time';

import { actionLabel, priceLabel, statusLabel, statusTone } from './money';

type Status = 'loading' | 'ready' | 'error';

export const OrderView = ({ id }: { readonly id: string }): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();

  const [order, setOrder] = useState<OrderResponse | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<OrderAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') return;

    let live = true;
    setStatus('loading');

    createMarketApi(client)
      .order(id)
      .then((found) => {
        if (!live) return;
        setOrder(found);
        setStatus('ready');
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(describeError(cause));
        setStatus('error');
      });

    return () => {
      live = false;
    };
  }, [client, id, sessionStatus]);

  const act = async (action: OrderAction): Promise<void> => {
    if (busyAction !== null) return;

    // A refund moves money: it asks first. The other moves are reversible enough to just do.
    if (action === 'REFUND' && !window.confirm('Refund this order? The money leaves escrow.')) {
      return;
    }

    setBusyAction(action);
    setActionError(null);

    try {
      setOrder(await createMarketApi(client).act(id, { action }));
    } catch (cause) {
      setActionError(describeError(cause));
    } finally {
      setBusyAction(null);
    }
  };

  if (status === 'loading') {
    return (
      <div className="flex flex-col gap-sm" aria-busy>
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-24 w-full" />
      </div>
    );
  }

  if (status === 'error' || order === null) {
    return (
      <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-md">
        <p role="alert" className="text-body text-danger">
          {error ?? 'That order could not be loaded.'}
        </p>
        <Link href="/market/orders" className={buttonClass('secondary', 'sm')}>
          <ArrowLeft aria-hidden className="size-4" />
          All orders
        </Link>
      </div>
    );
  }

  const now = new Date();
  const counterparty = order.isBuyer ? order.seller : order.buyer;

  return (
    <div className="flex flex-col gap-lg">
      <Link
        href="/market/orders"
        className="flex items-center gap-xs text-small text-muted hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Orders
      </Link>

      <header className="flex flex-col gap-xs">
        <div className="flex flex-wrap items-center gap-xs">
          <h1 className="text-heading">Order</h1>
          <span
            className={cn('rounded-full px-[6px] py-[1px] text-caption', statusTone(order.status))}
          >
            {statusLabel[order.status] ?? order.status}
          </span>
        </div>
        <p className="text-small text-muted">
          {order.isBuyer ? 'Bought from' : 'Sold to'}{' '}
          <span className="text-text">{counterparty.displayName}</span>
        </p>
      </header>

      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border px-md">
        {order.items.map((item) => (
          <li key={item.listingId} className="flex items-center gap-sm py-sm">
            <span className="flex flex-1 flex-col">
              <span className="text-body">{item.title}</span>
              <span className="text-caption text-muted">
                {priceLabel(item.unitPriceMinor, order.currency)} × {item.quantity}
              </span>
            </span>
            <span className="text-body font-medium">
              {priceLabel(item.lineTotalMinor, order.currency)}
            </span>
          </li>
        ))}
      </ul>

      <dl className="flex flex-col gap-xs rounded-lg bg-raised p-md text-small">
        <div className="flex justify-between">
          <dt className="text-muted">Goods</dt>
          <dd>{priceLabel(order.subtotalMinor, order.currency)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Delivery</dt>
          <dd>{priceLabel(order.shippingMinor, order.currency)}</dd>
        </div>
        {order.isSeller ? (
          <div className="flex justify-between">
            <dt className="text-muted">Platform fee</dt>
            <dd>−{priceLabel(order.commissionMinor, order.currency)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between border-t border-border pt-xs text-body font-semibold">
          <dt>Total</dt>
          <dd>{priceLabel(order.totalMinor, order.currency)}</dd>
        </div>
      </dl>

      <p className="flex items-start gap-xs text-small text-muted">
        <MapPin aria-hidden className="mt-[2px] size-4 shrink-0" />
        {order.shippingAddress}
      </p>

      {order.availableActions.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-sm">
          {order.availableActions.map((action) => (
            <button
              key={action}
              type="button"
              disabled={busyAction !== null}
              onClick={() => void act(action)}
              className={buttonClass(action === 'CANCEL' ? 'secondary' : 'primary', 'sm')}
            >
              {busyAction === action ? 'Working…' : (actionLabel[action] ?? action)}
            </button>
          ))}
        </div>
      )}

      {actionError === null ? null : (
        <p role="alert" className="text-small text-danger">
          {actionError}
        </p>
      )}

      <section className="flex flex-col gap-xs">
        <h2 className="text-body font-semibold">History</h2>
        <ol className="flex flex-col gap-xs">
          {order.timeline.map((event, index) => (
            <li
              key={`${event.status}-${String(index)}`}
              className="flex items-center gap-sm text-small"
            >
              <span className="w-2 shrink-0 self-stretch rounded-full bg-primary/40" aria-hidden />
              <span className="text-text">{statusLabel[event.status] ?? event.status}</span>
              <span className="text-muted">by {event.actor.toLowerCase()}</span>
              <span className="ml-auto text-caption text-muted" suppressHydrationWarning>
                {relativeTime(event.at, now)}
              </span>
            </li>
          ))}
        </ol>
        {order.expiresAt === null ? null : (
          <p className="text-caption text-muted" suppressHydrationWarning>
            The stock is held until {new Date(order.expiresAt).toLocaleString('en-GB')}.
          </p>
        )}
      </section>
    </div>
  );
};
