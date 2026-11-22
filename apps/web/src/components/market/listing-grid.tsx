'use client';

/**
 * The marketplace shelf.
 *
 * A grid of listings with a search box and two tabs: everything on sale, and the seller's own
 * shelf. The tabs are URL state for the same reason the blog's are — a link to "my listings"
 * should open "my listings".
 *
 * The card shows the **available** count, not the stock: two of five units held by unpaid
 * carts means three are buyable, and a card that says "5 left" then refuses a cart of three
 * is the most annoying bug a shop can have.
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PackagePlus, Search, ShoppingBag } from 'lucide-react';

import type { ListingSummaryResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { Input } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createMarketApi } from '@/lib/market-api';
import { useSession } from '@/lib/session';

import { priceLabel, statusLabel, statusTone } from './money';

type Status = 'loading' | 'ready' | 'error';

export const ListingGrid = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();
  const params = useSearchParams();

  const mine = params.get('mine') === 'true';
  const search = params.get('q') ?? '';

  const [term, setTerm] = useState(search);
  const [listings, setListings] = useState<readonly ListingSummaryResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (nextCursor?: string): Promise<void> => {
      if (sessionStatus !== 'authenticated') return;

      if (nextCursor === undefined) {
        setStatus('loading');
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const page = await createMarketApi(client).listings({
          ...(search === '' ? {} : { q: search }),
          ...(mine ? { mine: true } : {}),
          ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
        });

        setListings((current) => {
          if (nextCursor === undefined) return page.items;
          const seen = new Set(current.map((listing) => listing.id));
          return [...current, ...page.items.filter((listing) => !seen.has(listing.id))];
        });
        setCursor(page.nextCursor);
        setStatus('ready');
      } catch (cause) {
        setError(describeError(cause));
        setStatus('error');
      } finally {
        setLoadingMore(false);
      }
    },
    [client, mine, search, sessionStatus],
  );

  useEffect(() => {
    setTerm(search);
    void load();
  }, [load, search]);

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex flex-wrap items-center gap-sm">
        <nav className="flex items-center gap-xs" aria-label="Listing views">
          <Link
            href="/market"
            aria-current={!mine ? 'page' : undefined}
            className={cn(
              'flex h-9 items-center rounded-full px-sm text-small transition-colors',
              mine ? 'text-muted hover:bg-raised' : 'bg-primary/10 font-medium text-primary',
            )}
          >
            For sale
          </Link>
          <Link
            href="/market?mine=true"
            aria-current={mine ? 'page' : undefined}
            className={cn(
              'flex h-9 items-center rounded-full px-sm text-small transition-colors',
              mine ? 'bg-primary/10 font-medium text-primary' : 'text-muted hover:bg-raised',
            )}
          >
            My listings
          </Link>
        </nav>

        <Link href="/market/new" className={cn(buttonClass('primary', 'sm'), 'ml-auto')}>
          <PackagePlus aria-hidden className="size-4" />
          Sell something
        </Link>
      </div>

      {/* A real form, so pressing Enter searches and the URL carries the term. */}
      <form action="/market" method="get" role="search" className="flex items-center gap-xs">
        {mine ? <input type="hidden" name="mine" value="true" /> : null}
        <div className="relative flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-sm top-1/2 size-4 -translate-y-1/2 text-muted"
          />
          <Input
            name="q"
            aria-label="Search listings"
            placeholder="Search by title"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            className="pl-[36px]"
          />
        </div>
        <button type="submit" className={buttonClass('secondary', 'sm')}>
          Search
        </button>
      </form>

      {status === 'loading' ? (
        <div className="grid gap-sm sm:grid-cols-2" aria-busy>
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="flex flex-col gap-xs rounded-xl border border-border p-md">
              <div className="skeleton h-5 w-40" />
              <div className="skeleton h-4 w-full" />
              <div className="skeleton h-4 w-24" />
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

      {status === 'ready' && listings.length === 0 ? (
        <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-lg">
          <ShoppingBag aria-hidden className="size-6 text-muted" />
          <p className="text-body text-muted">
            {mine
              ? 'Nothing on your shelf yet. A draft stays private until you put it on sale.'
              : search === ''
                ? 'Nothing is for sale yet. Be the first seller.'
                : `Nothing matches “${search}”.`}
          </p>
          <Link href="/market/new" className={buttonClass('primary', 'sm')}>
            List an item
          </Link>
        </div>
      ) : null}

      <ul className="grid gap-sm sm:grid-cols-2">
        {listings.map((listing) => (
          <li key={listing.id}>
            <Link
              href={`/market/${listing.slug}`}
              className="flex h-full flex-col gap-xs rounded-xl border border-border p-md transition-colors hover:border-primary/50 hover:bg-primary/5"
            >
              <span className="flex items-start gap-xs">
                <span className="text-body font-medium">{listing.title}</span>
                {listing.status === 'ACTIVE' ? null : (
                  <span
                    className={cn(
                      'ml-auto shrink-0 rounded-full px-[6px] py-[1px] text-caption',
                      statusTone(listing.status),
                    )}
                  >
                    {statusLabel[listing.status] ?? listing.status}
                  </span>
                )}
              </span>

              <span className="text-h3 font-semibold">
                {priceLabel(listing.priceMinor, listing.currency)}
              </span>

              <span className="mt-auto flex flex-wrap items-center gap-xs text-caption text-muted">
                <span>{listing.seller.displayName}</span>
                <span aria-hidden>·</span>
                {listing.available === 0 ? (
                  <span className="text-warning">Sold out</span>
                ) : (
                  <span>
                    {listing.available} {listing.available === 1 ? 'left' : 'left'}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {cursor !== null ? (
        <button
          type="button"
          onClick={() => void load(cursor)}
          disabled={loadingMore}
          className={cn(buttonClass('secondary', 'sm'), 'self-center')}
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
};
