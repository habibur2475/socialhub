'use client';

/**
 * Writing a listing.
 *
 * The price is a **string** on the way in and out of this form, and it is the server's schema
 * that turns it into minor units. Rounding in the form would be a second implementation of
 * the pricing rule, and the one place it disagreed with the server would be the place a
 * seller lost a hundredth of a taka.
 *
 * "Save as draft" and "put on sale" are one form and two buttons: a draft with zero stock is
 * legal, an active listing with zero stock is not, and the schema says so.
 */

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';

import {
  MARKET_CURRENCIES,
  createListingRequestSchema,
  type CreateListingRequestInput,
  type MarketCurrency,
} from '@socialhub/contracts';
import type { ListingResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { Field, Input } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createMarketApi } from '@/lib/market-api';
import { useSession } from '@/lib/session';

export const ListingEditor = ({
  existing,
}: {
  readonly existing?: ListingResponse | undefined;
}): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();
  const router = useRouter();

  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [price, setPrice] = useState(
    existing === undefined ? '' : (existing.priceMinor / 100).toFixed(2),
  );
  const [stock, setStock] = useState(existing === undefined ? '1' : String(existing.stock));
  const [currency, setCurrency] = useState<MarketCurrency>(existing?.currency ?? 'BDT');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});

  const preview = useMemo(() => {
    const parsed = createListingRequestSchema.safeParse({
      title,
      description,
      price,
      currency,
      stock,
      status: 'DRAFT',
    });
    return parsed.success ? parsed.data.price : null;
  }, [currency, description, price, stock, title]);

  const submit = async (status: 'DRAFT' | 'ACTIVE'): Promise<void> => {
    if (busy) return;

    // The raw form values, with the price still a string: the schema (here and on the
    // server) is what turns `250.50` into 25 050 minor units, once.
    // `stock` is `coerce`d by the schema, but a coerced field accepts a number on the wire
    // too — parsing the string here keeps the form's state a string and the request a number.
    const draft: CreateListingRequestInput = {
      title,
      description,
      price,
      currency,
      stock: Number(stock.trim() === '' ? '0' : stock),
      status,
    };
    const parsed = createListingRequestSchema.safeParse(draft);

    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues)
        next[issue.path.join('.') || '_form'] ??= issue.message;
      setIssues(next);
      setError(null);
      return;
    }

    setIssues({});
    setBusy(true);
    setError(null);

    try {
      const api = createMarketApi(client);
      const saved =
        existing === undefined
          ? await api.createListing(draft)
          : await api.updateListing(existing.id, {
              title: parsed.data.title,
              description: parsed.data.description ?? '',
              price,
              stock: parsed.data.stock,
              status,
            });

      router.push(`/market/${saved.slug}`);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const issue = (key: string): string | undefined => issues[key];

  return (
    <div className="flex flex-col gap-lg">
      <header className="flex flex-col gap-xs">
        <h1 className="text-heading">
          {existing === undefined ? 'Sell something' : 'Edit listing'}
        </h1>
        <p className="text-body text-muted">
          A draft is private. Putting it on sale needs at least one unit in stock and a price of at
          least 1.00.
        </p>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit('ACTIVE');
        }}
        className="flex flex-col gap-md"
      >
        <Field
          label="What is it?"
          htmlFor="listing-title"
          required
          {...(issue('title') === undefined ? {} : { error: issue('title') })}
        >
          <Input
            id="listing-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            required
          />
        </Field>

        <Field
          label="Description"
          htmlFor="listing-description"
          hint="Condition, size, what is in the box"
          {...(issue('description') === undefined ? {} : { error: issue('description') })}
        >
          <textarea
            id="listing-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            maxLength={4_000}
            className="resize-y rounded-md border border-border-strong/40 bg-surface p-sm text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          />
        </Field>

        <div className="grid gap-md sm:grid-cols-3">
          <Field
            label="Price"
            htmlFor="listing-price"
            required
            hint={preview === null ? 'Like 250 or 250.50' : `${preview / 100} exactly`}
            {...(issue('price') === undefined ? {} : { error: issue('price') })}
          >
            <Input
              id="listing-price"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              inputMode="decimal"
              placeholder="250"
              required
            />
          </Field>

          <Field label="Currency" htmlFor="listing-currency">
            <select
              id="listing-currency"
              value={currency}
              onChange={(event) => setCurrency(event.target.value as MarketCurrency)}
              className="h-11 w-full rounded-md border border-border-strong/40 bg-surface px-sm text-body text-text"
            >
              {MARKET_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="In stock"
            htmlFor="listing-stock"
            required
            {...(issue('stock') === undefined ? {} : { error: issue('stock') })}
          >
            <Input
              id="listing-stock"
              value={stock}
              onChange={(event) => setStock(event.target.value)}
              inputMode="numeric"
              required
            />
          </Field>
        </div>

        {error === null ? null : (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-sm">
          <button
            type="submit"
            disabled={busy || sessionStatus !== 'authenticated'}
            className={buttonClass('primary', 'md')}
          >
            {busy ? 'Saving…' : 'Put on sale'}
          </button>
          <button
            type="button"
            onClick={() => void submit('DRAFT')}
            disabled={busy}
            className={buttonClass('secondary', 'md')}
          >
            Save as draft
          </button>
          <button
            type="button"
            onClick={() => router.push('/market')}
            className={cn(buttonClass('ghost', 'md'), 'ml-auto')}
          >
            <ArrowLeft aria-hidden className="size-4" />
            Back
          </button>
        </div>
      </form>
    </div>
  );
};
