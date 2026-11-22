'use client';

/**
 * The cart.
 *
 * Three numbers, and the third is the one that matters: the total that gets **quoted** back
 * to the server at checkout. It is computed here, in the browser, from the same integer
 * arithmetic the server runs, and a stale cart comes back as a `409` instead of a quiet
 * overcharge.
 *
 * Checkout answers with an array — one order per seller — and the confirmation lists every
 * one of them, because "your order" is not one order when two shops are involved.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShoppingCart, Trash2 } from 'lucide-react';

import {
  MAX_QUANTITY_PER_LINE,
  priceCart,
  type Listing as KernelListing,
} from '@socialhub/kernel/browser';
import type { ListingResponse, OrderResponse } from '@socialhub/contracts';

import { buttonClass } from '@/components/ui/button-styles';
import { Field, Input } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/form';
import { createMarketApi } from '@/lib/market-api';
import { useSession } from '@/lib/session';

import { priceLabel } from './money';

/** Flat postage per seller. The kernel prices it; the server charges the same rate. */
export const SHIPPING_MINOR = 6_000;

/** The platform's cut of the goods. Shown for information; the server takes it, not the cart. */
export const COMMISSION_BPS = 1_000;

export type CartLine = { readonly listing: ListingResponse; readonly quantity: number };

export const CartView = (): React.JSX.Element => {
  const { client, status: sessionStatus } = useSession();

  const [lines, setLines] = useState<readonly CartLine[]>([]);
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<readonly OrderResponse[]>([]);

  const pricing = useMemo(() => {
    if (lines.length === 0) return null;

    const listings = new Map<string, KernelListing>(
      lines.map((line) => [
        line.listing.id,
        {
          id: line.listing.id,
          sellerId: line.listing.seller.accountId,
          status: line.listing.status,
          price: { currency: line.listing.currency, minor: line.listing.priceMinor },
          stock: line.listing.stock,
          reserved: line.listing.stock - line.listing.available,
        },
      ]),
    );

    return priceCart({
      lines: lines.map((line) => ({ listingId: line.listing.id, quantity: line.quantity })),
      listings,
      shippingMinor: SHIPPING_MINOR,
      commissionBps: COMMISSION_BPS,
    });
  }, [lines]);

  const total = pricing?.ok === true ? pricing.value.total.minor : null;
  const currency = lines[0]?.listing.currency ?? 'BDT';

  const add = useCallback((listing: ListingResponse, quantity: number) => {
    setLines((current) => {
      const existing = current.find((line) => line.listing.id === listing.id);
      if (existing === undefined) return [...current, { listing, quantity }];
      return current.map((line) =>
        line.listing.id === listing.id
          ? { listing, quantity: Math.min(MAX_QUANTITY_PER_LINE, line.quantity + quantity) }
          : line,
      );
    });
    setPlaced([]);
  }, []);

  // The listing page hands its cart line over through a session-storage note: the two
  // screens are separate routes, and a context provider for one array is more machinery
  // than the feature deserves.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = window.sessionStorage.getItem('socialhub.cart.add');
    if (raw === null) return;
    window.sessionStorage.removeItem('socialhub.cart.add');

    try {
      const item = JSON.parse(raw) as { listing: ListingResponse; quantity: number };
      add(item.listing, item.quantity);
    } catch {
      // A corrupt note is dropped rather than crashing the cart.
    }
  }, [add]);

  const checkout = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (total === null || busy) return;

    if (address.trim().length < 10) {
      setAddressError('A full address, please — street, area and postcode');
      return;
    }

    setAddressError(null);
    setBusy(true);
    setError(null);

    try {
      const orders = await createMarketApi(client).checkout({
        lines: lines.map((line) => ({ listingId: line.listing.id, quantity: line.quantity })),
        shippingAddress: address.trim(),
        ...(phone.trim() === '' ? {} : { contactPhone: phone.trim() }),
        quotedTotalMinor: total,
      });

      setPlaced(orders);
      setLines([]);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (placed.length > 0) {
    return (
      <div className="flex flex-col gap-md">
        <h2 className="text-h2">Order placed</h2>
        <p className="text-body text-muted">
          {placed.length === 1
            ? 'Your order is held for 30 minutes while payment completes.'
            : `Your cart became ${placed.length} orders, one per seller. Each ships separately.`}
        </p>

        <ul className="flex flex-col gap-sm">
          {placed.map((order) => (
            <li key={order.id} className="rounded-lg border border-border p-md">
              <div className="flex items-center justify-between gap-sm">
                <span className="text-body font-medium">{order.seller.displayName}</span>
                <span className="text-body">{priceLabel(order.totalMinor, order.currency)}</span>
              </div>
              <p className="text-small text-muted">
                {order.items.length} item{order.items.length === 1 ? '' : 's'} ·{' '}
                {priceLabel(order.shippingMinor, order.currency)} delivery
              </p>
              <Link
                href={`/market/orders/${order.id}`}
                className="mt-xs inline-block text-small font-medium text-primary hover:underline"
              >
                Open the order
              </Link>
            </li>
          ))}
        </ul>

        <Link href="/market/orders" className={buttonClass('secondary', 'sm')}>
          All my orders
        </Link>
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="flex flex-col items-start gap-sm rounded-lg border border-border p-lg">
        <ShoppingCart aria-hidden className="size-6 text-muted" />
        <p className="text-body text-muted">Your cart is empty.</p>
        <Link href="/market" className={buttonClass('primary', 'sm')}>
          Browse the market
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-lg">
      <ul className="flex flex-col divide-y divide-border">
        {lines.map((line) => (
          <li key={line.listing.id} className="flex items-start gap-sm py-sm">
            <div className="flex flex-1 flex-col gap-[2px]">
              <Link href={`/market/${line.listing.slug}`} className="text-body font-medium">
                {line.listing.title}
              </Link>
              <span className="text-small text-muted">
                {priceLabel(line.listing.priceMinor, line.listing.currency)} × {line.quantity}
              </span>
            </div>

            <span className="text-body font-medium">
              {priceLabel(line.listing.priceMinor * line.quantity, line.listing.currency)}
            </span>

            <button
              type="button"
              aria-label={`Remove ${line.listing.title}`}
              onClick={() =>
                setLines((current) =>
                  current.filter((other) => other.listing.id !== line.listing.id),
                )
              }
              className="flex size-11 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-danger"
            >
              <Trash2 aria-hidden className="size-4" />
            </button>
          </li>
        ))}
      </ul>

      {pricing?.ok === true ? (
        <dl className="flex flex-col gap-xs rounded-lg bg-raised p-md text-small">
          <div className="flex justify-between">
            <dt className="text-muted">Goods</dt>
            <dd>{priceLabel(pricing.value.subtotal.minor, currency)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">
              Delivery
              {pricing.value.shipping.minor > SHIPPING_MINOR
                ? ` (${pricing.value.shipping.minor / SHIPPING_MINOR} sellers)`
                : ''}
            </dt>
            <dd>{priceLabel(pricing.value.shipping.minor, currency)}</dd>
          </div>
          <div className="flex justify-between border-t border-border pt-xs text-body font-semibold">
            <dt>Total</dt>
            <dd>{priceLabel(pricing.value.total.minor, currency)}</dd>
          </div>
        </dl>
      ) : (
        <p role="alert" className="text-small text-danger">
          One of these items can no longer be bought in that quantity. Remove it and re-add what is
          available.
        </p>
      )}

      <form onSubmit={(event) => void checkout(event)} className="flex flex-col gap-md">
        <Field
          label="Delivery address"
          htmlFor="cart-address"
          required
          hint="Street, area, city and postcode"
          {...(addressError === null ? {} : { error: addressError })}
        >
          <Input
            id="cart-address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            autoComplete="street-address"
            invalid={addressError !== null}
          />
        </Field>

        <Field label="Phone" htmlFor="cart-phone" hint="Optional, for the delivery driver">
          <Input
            id="cart-phone"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            inputMode="tel"
            autoComplete="tel"
          />
        </Field>

        {error === null ? null : (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || total === null || sessionStatus !== 'authenticated'}
          className={cn(buttonClass('primary', 'md'), 'self-start')}
        >
          {busy ? 'Placing the order…' : total === null ? 'Check your cart' : 'Place the order'}
        </button>
      </form>
    </div>
  );
};
