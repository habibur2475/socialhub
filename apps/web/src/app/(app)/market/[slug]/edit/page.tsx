/**
 * Editing a listing.
 *
 * The listing is loaded first so the form starts with what is stored; the editor's own submit
 * sends a patch built from the same schema a create uses.
 */

'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { ListingResponse } from '@socialhub/contracts';

import { ListingEditor } from '@/components/market/listing-editor';
import { describeError } from '@/lib/form';
import { createMarketApi } from '@/lib/market-api';
import { useSession } from '@/lib/session';

export default function EditListingPage(): React.JSX.Element {
  const { client, status } = useSession();
  const params = useParams<{ slug: string }>();

  const [listing, setListing] = useState<ListingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;

    let live = true;
    createMarketApi(client)
      .listing(params.slug)
      .then((found) => {
        if (live) setListing(found);
      })
      .catch((cause: unknown) => {
        if (live) setError(describeError(cause));
      });

    return () => {
      live = false;
    };
  }, [client, params.slug, status]);

  if (error !== null) {
    return (
      <div className="mx-auto max-w-[640px]">
        <p role="alert" className="text-body text-danger">
          {error}
        </p>
      </div>
    );
  }

  if (listing === null) {
    return (
      <div className="mx-auto flex max-w-[640px] flex-col gap-sm" aria-busy>
        <div className="skeleton h-8 w-48" />
        <div className="skeleton h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[640px]">
      <ListingEditor key={listing.id} existing={listing} />
    </div>
  );
}
