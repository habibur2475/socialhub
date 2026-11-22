/**
 * Market — listings, carts and order pricing.
 *
 * Three properties this file holds, each of which is a bug if it lives anywhere else:
 *
 *   1. **A price is never a float.** Every amount is integer minor units, from the asking
 *      price to the total in the cart. A marketplace that loses a paisa per order is a
 *      marketplace whose reconciliation never closes, and the loss starts with
 *      `price * quantity` on a `number`.
 *   2. **The stock held by an unpaid order is visible.** An order that reserves the last
 *      unit but has not been paid must not let the next buyer add it again — so quantity
 *      is checked against `available`, which is stock minus *reserved*, not stock.
 *   3. **The buyer's total is computed once, here.** Shipping, and the fact that the sum
 *      of the lines must equal what the buyer is charged, are one function; a second
 *      implementation in the checkout page is how a cart and a receipt disagree by a taka.
 */

import { type Result, fail, ok } from '../result.js';
import type { Money } from '../money.js';
import { MAX_COMMISSION_BPS, computeSplit, type SplitResult } from '../revenue.js';

export type ListingStatus = 'DRAFT' | 'ACTIVE' | 'SOLD_OUT' | 'WITHDRAWN';

export const LISTING_STATUSES: readonly ListingStatus[] = [
  'DRAFT',
  'ACTIVE',
  'SOLD_OUT',
  'WITHDRAWN',
];

/**
 * The legal moves.
 *
 * `SOLD_OUT` is reachable from `ACTIVE` only, and it is *automatic*: the last unit selling
 * moves a listing there rather than leaving it active with a stock of zero, because an
 * active listing a buyer cannot buy is a dead end that looks alive. Restocking moves it
 * back. Withdrawal is reachable from everything except itself and is terminal — a withdrawn
 * listing keeps its orders and its URL but can never be bought again.
 */
const TRANSITIONS: Readonly<Record<ListingStatus, readonly ListingStatus[]>> = {
  DRAFT: ['ACTIVE', 'WITHDRAWN'],
  ACTIVE: ['SOLD_OUT', 'WITHDRAWN', 'DRAFT'],
  SOLD_OUT: ['ACTIVE', 'WITHDRAWN'],
  WITHDRAWN: [],
};

export const canMoveListing = (from: ListingStatus, to: ListingStatus): boolean =>
  TRANSITIONS[from].includes(to);

export type ListingRefusal =
  | {
      readonly code: 'INVALID_TRANSITION';
      readonly from: ListingStatus;
      readonly to: ListingStatus;
    }
  | { readonly code: 'NOTHING_TO_SELL'; readonly stock: number }
  | { readonly code: 'PRICE_TOO_LOW'; readonly minor: number }
  | { readonly code: 'CURRENCY_MISMATCH' }
  | { readonly code: 'EMPTY_CART' }
  | { readonly code: 'TOO_MANY_OF_ONE_ITEM'; readonly limit: number }
  | { readonly code: 'NOT_ENOUGH_STOCK'; readonly listingId: string; readonly available: number }
  | { readonly code: 'LISTING_NOT_BUYABLE'; readonly listingId: string }
  | { readonly code: 'COMMISSION_REFUSED' }
  | { readonly code: 'TOTAL_MISMATCH'; readonly expected: number; readonly actual: number };

/** A listing price of zero is not a free item, it is a mistake that mints free orders. */
export const MIN_PRICE_MINOR = 100;
export const MAX_PRICE_MINOR = 100_000_000;
export const MAX_QUANTITY_PER_LINE = 20;
export const MAX_CART_LINES = 20;

export type Listing = {
  readonly id: string;
  readonly sellerId: string;
  readonly status: ListingStatus;
  readonly price: Money;
  readonly stock: number;
  /** Held by orders that have not been paid yet. */
  readonly reserved: number;
};

/** What a buyer may actually put in a cart: stock the unpaid orders have not claimed. */
export const availableOf = (listing: Listing): number =>
  Math.max(0, listing.stock - listing.reserved);

/** Whether this listing can be bought right now, stock included, ignoring quantity. */
export const isBuyable = (listing: Listing): boolean =>
  listing.status === 'ACTIVE' && availableOf(listing) > 0;

export const checkListingForSale = (
  status: ListingStatus,
  priceMinor: number,
  stock: number,
): ListingRefusal | null => {
  if (priceMinor < MIN_PRICE_MINOR || priceMinor > MAX_PRICE_MINOR) {
    return { code: 'PRICE_TOO_LOW', minor: priceMinor };
  }
  if (status === 'ACTIVE' && stock <= 0) return { code: 'NOTHING_TO_SELL', stock };
  return null;
};

export type CartLine = {
  readonly listingId: string;
  readonly quantity: number;
};

export type PricedLine = {
  readonly listingId: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineTotal: Money;
};

export type CartPricing = {
  readonly lines: readonly PricedLine[];
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly total: Money;
  readonly commission: Money;
  readonly sellerNet: Money;
};

export type CartRequest = {
  readonly lines: readonly CartLine[];
  readonly listings: ReadonlyMap<string, Listing>;
  readonly shippingMinor: number;
  readonly commissionBps: number;
};

/**
 * Prices a cart.
 *
 * The order of the checks is the order a buyer experiences: is the listing buyable at all,
 * is there enough of it, is the whole cart shaped like something we accept. A cart error
 * names the listing, because "not enough stock" without saying *of what* is a message that
 * sends the buyer back to hunt through their own cart.
 */
export const priceCart = (request: CartRequest): Result<CartPricing, ListingRefusal> => {
  const { lines, listings, shippingMinor, commissionBps } = request;

  if (lines.length === 0) return fail({ code: 'EMPTY_CART' });
  if (lines.length > MAX_CART_LINES) return fail({ code: 'EMPTY_CART' });
  if (commissionBps < 0 || commissionBps > MAX_COMMISSION_BPS)
    return fail({ code: 'COMMISSION_REFUSED' });

  const priced: PricedLine[] = [];
  let currency: Money['currency'] | null = null;
  let subtotalMinor = 0;

  // A listing repeated across two lines would let a buyer bypass the per-line quantity cap
  // by asking for it twice; the cart is therefore keyed by listing, not by row.
  const seen = new Set<string>();

  for (const line of lines) {
    if (seen.has(line.listingId))
      return fail({ code: 'TOO_MANY_OF_ONE_ITEM', limit: MAX_QUANTITY_PER_LINE });
    seen.add(line.listingId);

    const listing = listings.get(line.listingId);
    if (listing === undefined)
      return fail({ code: 'LISTING_NOT_BUYABLE', listingId: line.listingId });

    const quantity = Math.trunc(line.quantity);
    if (!Number.isInteger(line.quantity) || quantity < 1) {
      return fail({
        code: 'NOT_ENOUGH_STOCK',
        listingId: line.listingId,
        available: availableOf(listing),
      });
    }
    if (quantity > MAX_QUANTITY_PER_LINE) {
      return fail({ code: 'TOO_MANY_OF_ONE_ITEM', limit: MAX_QUANTITY_PER_LINE });
    }
    if (!isBuyable(listing))
      return fail({ code: 'LISTING_NOT_BUYABLE', listingId: line.listingId });
    if (quantity > availableOf(listing)) {
      return fail({
        code: 'NOT_ENOUGH_STOCK',
        listingId: line.listingId,
        available: availableOf(listing),
      });
    }

    if (currency === null) {
      currency = listing.price.currency;
    } else if (currency !== listing.price.currency) {
      // A cart is charged in one currency. Converting silently would mean choosing a rate
      // on the buyer's behalf after they agreed to a price.
      return fail({ code: 'CURRENCY_MISMATCH' });
    }

    const lineMinor = listing.price.minor * quantity;
    subtotalMinor += lineMinor;

    priced.push({
      listingId: line.listingId,
      quantity,
      unitPrice: listing.price,
      lineTotal: { currency: listing.price.currency, minor: lineMinor },
    });
  }

  if (currency === null) return fail({ code: 'EMPTY_CART' });

  const subtotal: Money = { currency, minor: subtotalMinor };

  // Postage is charged once per seller, because a cart with two sellers becomes two orders
  // and two parcels. Charging a single flat rate while the orders each carry one would make
  // the quoted total disagree with the sum of the receipts.
  const sellerCount = new Set(lines.map((line) => listings.get(line.listingId)?.sellerId ?? ''))
    .size;
  const shipping: Money = {
    currency,
    minor: Math.max(0, Math.trunc(shippingMinor)) * Math.max(1, sellerCount),
  };
  const total: Money = { currency, minor: subtotalMinor + shipping.minor };

  // The platform's cut is taken from the goods, not from the shipping: postage is the
  // seller's cost passed through, and taking a commission on it would charge the seller
  // twice for the same taka.
  const split: Result<SplitResult, unknown> = computeSplit({
    gross: subtotal,
    commissionBps,
    parties: [{ partyId: 'seller', weightBps: 10_000 }],
  });

  if (!split.ok) return fail({ code: 'COMMISSION_REFUSED' });

  return ok({
    lines: priced,
    subtotal,
    shipping,
    total,
    commission: split.value.commission,
    sellerNet: split.value.lines[0]?.amount ?? { currency, minor: 0 },
  });
};

/** The total a buyer was quoted must equal the total computed from the lines. */
export const checkTotal = (quoted: Money, pricing: CartPricing): ListingRefusal | null =>
  quoted.minor === pricing.total.minor && quoted.currency === pricing.total.currency
    ? null
    : { code: 'TOTAL_MISMATCH', expected: pricing.total.minor, actual: quoted.minor };
