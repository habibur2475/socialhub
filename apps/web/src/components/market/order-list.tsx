'use client';

/**
 * The order list.
 *
 * Two roles, one component: what you bought and what you sold. The role is URL state because
 * "my sales" is a place a seller returns to, and it should be a link.
 *
 * The status filter repeats the server's list rather than inventing one: an unknown status
 * is a `422`, so the UI must not offer a value the API would refuse.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Receipt } from 'lucide-react';

import { ORDER_STATUSES, type OrderResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createMarketApi } from '@/lib/market-api';
import { useSession } from '@/lib/session';
import { relativeTime } from '@/lib/time';

import { priceLabel, statusLabel, statusTone } from './money';

type Status = 'loading' | 'ready' | 'error';

export const OrderList = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();
  const params = useSearchParams();

  const selling = params.get('role') === 'SELLING';
  const statusFilter = params.get('status');

  const [orders, setOrders] = useState<readonly OrderResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (sessionStatus !== 'authenticated') return;

    setStatus('loading');
    setError(null);

    try {
      const page = await createMarketApi(client).orders({
        role: selling ? 'SELLING' : 'BUYING',
        ...(statusFilter === null ? {} : { status: statusFilter as OrderResponse['status'] }),
      });
      setOrders(page.items);
      setCursor(page.nextCursor);
      setStatus('ready');
    } catch (cause) {
      setError(describeError(cause));
      setStatus('error');
    }
  }, [client, selling, sessionStatus, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const now = new Date();

  return (
    <div className="flex flex-col gap-lg">
      <nav className="flex items-center gap-xs" aria-label="Order views">
        <Link
          href="/market/orders"
          aria-current={!selling ? 'page' : undefined}
          className={cn(
            'flex h-9 items-center rounded-full px-sm text-small transition-colors',
            selling ? 'text-muted hover:bg-raised' : 'bg-primary/10 font-medium text-primary',
          )}
        >
          Buying
        </Link>
        <Link
          href="/market/orders?role=SELLING"
          aria-current={selling ? 'page' : undefined}
          className={cn(
            'flex h-9 items-center rounded-full px-sm text-small transition-colors',
            selling ? 'bg-primary/10 font-medium text-primary' : 'text-muted hover:bg-raised',
          )}
        >
          Selling
        </Link>
      </nav>

      <div className="flex flex-wrap gap-xs">
        <Link
          href={selling ? '/market/orders?role=SELLING' : '/market/orders'}
          className={cn(
            'rounded-full px-sm py-[2px] text-caption',
            statusFilter === null ? 'bg-raised font-medium' : 'text-muted hover:bg-raised',
          )}
        >
          All
        </Link>
        {ORDER_STATUSES.map((option) => (
          <Link
            key={option}
            href={`/market/orders?${selling ? 'role=SELLING&' : ''}status=${option}`}
            className={cn(
              'rounded-full px-sm py-[2px] text-caption',
              statusFilter === option ? 'bg-raised font-medium' : 'text-muted hover:bg-raised',
            )}
          >
            {statusLabel[option] ?? option}
          </Link>
        ))}
      </div>

      {status === 'loading' ? (
        <div className="flex flex-col gap-sm" aria-busy>
          {[0, 1].map((key) => (
            <div key={key} className="rounded-lg border border-border p-md">
              <div className="skeleton h-5 w-48" />
              <div className="skeleton mt-xs h-4 w-32" />
            </div>
          ))}
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="flex flex-col gap-sm rounded-lg border border-border p-md">
          <p role="alert" className="text-body text-danger">
            {error}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="self-start text-small font-medium text-primary underline"
          >
            Try again
          </button>
        </div>
      ) : null}

      {status === 'ready' && orders.length === 0 ? (
        <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-lg">
          <Receipt aria-hidden className="size-6 text-muted" />
          <p className="text-body text-muted">
            {selling
              ? 'Nobody has ordered from you yet.'
              : statusFilter === null
                ? 'You have not bought anything yet.'
                : 'No orders in this state.'}
          </p>
          <Link href="/market" className={buttonClass('primary', 'sm')}>
            Browse the market
          </Link>
        </div>
      ) : null}

      <ul className="flex flex-col gap-sm">
        {orders.map((order) => (
          <li key={order.id}>
            <Link
              href={`/market/orders/${order.id}`}
              className="flex flex-col gap-xs rounded-lg border border-border p-md transition-colors hover:border-primary/50"
            >
              <span className="flex flex-wrap items-center gap-xs">
                <span className="text-body font-medium">
                  {order.items.map((item) => item.title).join(', ')}
                </span>
                <span
                  className={cn(
                    'ml-auto rounded-full px-[6px] py-[1px] text-caption',
                    statusTone(order.status),
                  )}
                >
                  {statusLabel[order.status] ?? order.status}
                </span>
              </span>

              <span className="flex flex-wrap items-center gap-xs text-caption text-muted">
                <span>{selling ? order.buyer.displayName : order.seller.displayName}</span>
                <span aria-hidden>·</span>
                <span suppressHydrationWarning>{relativeTime(order.createdAt, now)}</span>
                <span aria-hidden>·</span>
                <span className="font-medium text-text">
                  {priceLabel(order.totalMinor, order.currency)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {cursor === null ? null : (
        <p className="text-center text-small text-muted">
          More orders are available — narrow the filter to see them.
        </p>
      )}
    </div>
  );
};
