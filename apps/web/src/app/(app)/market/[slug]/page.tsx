/**
 * One listing.
 *
 * The "add to cart" hand-off uses `sessionStorage` rather than a provider: the detail page and
 * the cart are separate routes, and one array does not justify a context that every market
 * page would then depend on.
 */

'use client';

import { useRouter, useParams } from 'next/navigation';

import type { ListingResponse } from '@socialhub/contracts';

import { ListingView } from '@/components/market/listing-view';

export default function ListingPage(): React.JSX.Element {
  const params = useParams<{ slug: string }>();
  const router = useRouter();

  const addToCart = (listing: ListingResponse, quantity: number): void => {
    window.sessionStorage.setItem('socialhub.cart.add', JSON.stringify({ listing, quantity }));
    router.push('/market/cart');
  };

  return (
    <div className="mx-auto max-w-[640px]">
      <ListingView key={params.slug} idOrSlug={params.slug} onAddToCart={addToCart} />
    </div>
  );
}
