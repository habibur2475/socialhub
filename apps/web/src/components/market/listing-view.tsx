'use client';

/**
 * One listing.
 *
 * Three audiences on one page, decided by two booleans the API already computed:
 *
 *   a visitor    price, seller, availability, and a quantity picker
 *   the seller   the stock/reserve split, and a link to edit
 *   both         nothing else — a draft never reaches this page for anyone but its seller
 *
 * The quantity picker is capped by `available`, not by `stock`, and the button says why when
 * it cannot work: a disabled button with no explanation is a dead end.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, Minus, Package, Plus, ShieldCheck, Truck } from 'lucide-react';

import type { ListingResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createMarketApi } from '@/lib/market-api';
import { useSession } from '@/lib/session';

import { priceLabel, statusLabel, statusTone } from './money';

type Status = 'loading' | 'ready' | 'error';

export const ListingView = ({
  idOrSlug,
  onAddToCart,
}: {
  readonly idOrSlug: string;
  readonly onAddToCart?: ((listing: ListingResponse, quantity: number) => void) | undefined;
}): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();

  const [listing, setListing] = useState<ListingResponse | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') return;

    let live = true;
    setStatus('loading');

    createMarketApi(client)
      .listing(idOrSlug)
      .then((found) => {
        if (!live) return;
        setListing(found);
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
  }, [client, idOrSlug, sessionStatus]);

  if (status === 'loading') {
    return (
      <div className="flex flex-col gap-sm" aria-busy>
        <div className="skeleton h-8 w-64" />
        <div className="skeleton h-6 w-32" />
        <div className="skeleton h-24 w-full" />
      </div>
    );
  }

  if (status === 'error' || listing === null) {
    return (
      <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-md">
        <p role="alert" className="text-body text-danger">
          {error ?? 'That listing could not be loaded.'}
        </p>
        <Link href="/market" className={buttonClass('secondary', 'sm')}>
          <ArrowLeft aria-hidden className="size-4" />
          Back to the market
        </Link>
      </div>
    );
  }

  const max = Math.min(listing.available, 20);
  const canBuy = !listing.isSeller && listing.available > 0 && listing.status === 'ACTIVE';

  return (
    <article className="flex flex-col gap-lg">
      <Link
        href="/market"
        className="flex items-center gap-xs text-small text-muted hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Market
      </Link>

      <header className="flex flex-col gap-xs">
        <div className="flex flex-wrap items-center gap-xs">
          <h1 className="text-heading">{listing.title}</h1>
          <span
            className={cn(
              'rounded-full px-[6px] py-[1px] text-caption',
              statusTone(listing.status),
            )}
          >
            {statusLabel[listing.status] ?? listing.status}
          </span>
        </div>

        <p className="text-h2 font-semibold">{priceLabel(listing.priceMinor, listing.currency)}</p>

        <p className="text-small text-muted">
          Sold by <span className="text-foreground">{listing.seller.displayName}</span>
          {listing.isSeller ? ' (you)' : ''}
        </p>
      </header>

      {listing.description === '' ? null : (
        <p className="whitespace-pre-line text-body text-muted">{listing.description}</p>
      )}

      <section className="flex flex-col gap-sm rounded-lg border border-border p-md">
        <div className="flex flex-wrap items-center gap-sm">
          <span className="flex items-center gap-xs text-small text-muted">
            <Package aria-hidden className="size-4" />
            {listing.available === 0
              ? 'None available right now'
              : `${listing.available} available`}
          </span>
          {listing.isSeller ? (
            <span className="rounded-full bg-raised px-xs py-[1px] text-caption text-muted">
              {listing.stock} in stock, {listing.stock - listing.available} held by unpaid orders
            </span>
          ) : null}
        </div>

        {listing.isSeller ? (
          <Link href={`/market/${listing.slug}/edit`} className={buttonClass('secondary', 'sm')}>
            Edit this listing
          </Link>
        ) : (
          <div className="flex flex-wrap items-center gap-sm">
            <div className="flex items-center gap-xs">
              <button
                type="button"
                aria-label="One fewer"
                onClick={() => setQuantity((current) => Math.max(1, current - 1))}
                disabled={quantity <= 1}
                className="flex size-11 items-center justify-center rounded-md border border-border-strong/40 disabled:opacity-40"
              >
                <Minus aria-hidden className="size-4" />
              </button>
              <span aria-live="polite" className="w-8 text-center text-body font-medium">
                {quantity}
              </span>
              <button
                type="button"
                aria-label="One more"
                onClick={() => setQuantity((current) => Math.min(max, current + 1))}
                disabled={quantity >= max}
                className="flex size-11 items-center justify-center rounded-md border border-border-strong/40 disabled:opacity-40"
              >
                <Plus aria-hidden className="size-4" />
              </button>
            </div>

            <button
              type="button"
              disabled={!canBuy}
              onClick={() => {
                setNotice(null);
                onAddToCart?.(listing, quantity);
              }}
              className={buttonClass('primary', 'md')}
            >
              Add to cart
            </button>

            {canBuy ? null : (
              <p className="text-small text-muted">
                {listing.status !== 'ACTIVE'
                  ? 'This listing is not on sale.'
                  : 'Another buyer holds every unit right now. Check back in half an hour.'}
              </p>
            )}
          </div>
        )}

        {notice === null ? null : (
          <p role="status" className="text-small text-success">
            {notice}
          </p>
        )}
      </section>

      <ul className="flex flex-col gap-xs text-small text-muted">
        <li className="flex items-center gap-xs">
          <Truck aria-hidden className="size-4" />
          One delivery charge per seller, however many items you buy from them.
        </li>
        <li className="flex items-center gap-xs">
          <ShieldCheck aria-hidden className="size-4" />
          Money is held until the order is delivered, and refunded if it is not.
        </li>
      </ul>
    </article>
  );
};
