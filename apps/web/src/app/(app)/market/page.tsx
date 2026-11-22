/**
 * The market.
 *
 * `useSearchParams` needs a Suspense boundary in the App Router or the whole page is forced
 * dynamic; the boundary wraps only the grid, so the heading paints immediately.
 */

'use client';

import { Suspense } from 'react';

import { ListingGrid } from '@/components/market/listing-grid';

export default function MarketPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-[880px] flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <h1 className="text-heading">Market</h1>
        <p className="max-w-[60ch] text-body text-muted">
          Things people are selling. Each seller is paid separately, and their delivery is separate
          too — a cart with two sellers becomes two orders.
        </p>
      </header>

      <Suspense
        fallback={
          <div className="grid gap-sm sm:grid-cols-2" aria-busy>
            <div className="skeleton h-28 w-full" />
            <div className="skeleton h-28 w-full" />
          </div>
        }
      >
        <ListingGrid />
      </Suspense>
    </div>
  );
}
