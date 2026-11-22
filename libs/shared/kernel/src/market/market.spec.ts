/**
 * Market policy.
 *
 * The tests that matter here are the ones a marketplace gets wrong quietly: a cart that adds
 * up to a different total than the receipt, stock that an unpaid order lets a second buyer
 * buy again, and a refund that gives back postage the platform already spent.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_QUANTITY_PER_LINE,
  availableOf,
  canMoveListing,
  checkListingForSale,
  checkTotal,
  isBuyable,
  priceCart,
  type Listing,
} from './listing.js';
import {
  RESERVATION_MINUTES,
  canMoveOrder,
  computeRefund,
  decideOrderMove,
  isExpired,
  isTerminal,
  reservationWindowMs,
  timelineOf,
} from './order.js';

const listing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 'l1',
  sellerId: 's1',
  status: 'ACTIVE',
  price: { currency: 'BDT', minor: 25_000 },
  stock: 5,
  reserved: 0,
  ...overrides,
});

const listingsOf = (...items: Listing[]): ReadonlyMap<string, Listing> =>
  new Map(items.map((item) => [item.id, item]));

describe('listing states', () => {
  it('lets a draft go live in either direction', () => {
    expect(canMoveListing('DRAFT', 'ACTIVE')).toBe(true);
    expect(canMoveListing('ACTIVE', 'DRAFT')).toBe(true);
  });

  it('treats a withdrawn listing as final', () => {
    for (const to of ['DRAFT', 'ACTIVE', 'SOLD_OUT'] as const) {
      expect(canMoveListing('WITHDRAWN', to)).toBe(false);
    }
  });

  it('restocks a sold-out listing back to active', () => {
    expect(canMoveListing('SOLD_OUT', 'ACTIVE')).toBe(true);
  });

  it('refuses selling out a draft that was never live', () => {
    expect(canMoveListing('DRAFT', 'SOLD_OUT')).toBe(false);
  });
});

describe('buyability', () => {
  it('counts stock minus what unpaid orders hold', () => {
    expect(availableOf(listing({ stock: 5, reserved: 2 }))).toBe(3);
    // A hold larger than the stock is a data bug, but it must read as zero, not negative.
    expect(availableOf(listing({ stock: 2, reserved: 5 }))).toBe(0);
  });

  it('is not buyable with every unit held by an unpaid order', () => {
    const held = listing({ stock: 1, reserved: 1 });
    expect(isBuyable(held)).toBe(false);
    expect(isBuyable(listing({ stock: 1, reserved: 0 }))).toBe(true);
  });

  it('is not buyable when the listing is not active', () => {
    expect(isBuyable(listing({ status: 'DRAFT' }))).toBe(false);
    expect(isBuyable(listing({ status: 'SOLD_OUT' }))).toBe(false);
  });

  it('refuses to put a zero or absurd price on sale', () => {
    expect(checkListingForSale('ACTIVE', 0, 1)).toEqual({ code: 'PRICE_TOO_LOW', minor: 0 });
    expect(checkListingForSale('ACTIVE', 99, 1)).toEqual({ code: 'PRICE_TOO_LOW', minor: 99 });
    expect(checkListingForSale('ACTIVE', 1_000, 0)).toEqual({ code: 'NOTHING_TO_SELL', stock: 0 });
    expect(checkListingForSale('ACTIVE', 25_000, 3)).toBeNull();
    // A draft may hold no stock yet: it is not on sale.
    expect(checkListingForSale('DRAFT', 25_000, 0)).toBeNull();
  });
});

describe('pricing a cart', () => {
  const request = (lines: { listingId: string; quantity: number }[], extras = {}) => ({
    lines,
    listings: listingsOf(
      listing({ id: 'l1', price: { currency: 'BDT', minor: 25_000 } }),
      listing({ id: 'l2', sellerId: 's2', price: { currency: 'BDT', minor: 9_900 }, stock: 2 }),
    ),
    shippingMinor: 6_000,
    commissionBps: 1_000,
    ...extras,
  });

  it('multiplies in integer minor units and adds shipping', () => {
    const priced = priceCart(request([{ listingId: 'l1', quantity: 2 }]));
    expect(priced.ok).toBe(true);
    if (!priced.ok) return;

    expect(priced.value.subtotal).toEqual({ currency: 'BDT', minor: 50_000 });
    expect(priced.value.shipping).toEqual({ currency: 'BDT', minor: 6_000 });
    expect(priced.value.total).toEqual({ currency: 'BDT', minor: 56_000 });
    expect(priced.value.lines[0]).toMatchObject({
      quantity: 2,
      unitPrice: { minor: 25_000 },
      lineTotal: { minor: 50_000 },
    });
  });

  /** The commission comes off the goods, not the postage. */
  it('takes commission from the goods and not from the shipping', () => {
    const priced = priceCart(request([{ listingId: 'l1', quantity: 2 }]));
    if (!priced.ok) throw new Error('expected a price');
    expect(priced.value.commission.minor).toBe(5_000);
    expect(priced.value.sellerNet.minor).toBe(45_000);
    // What the buyer pays is untouched by the split: conservation across the whole cart.
    expect(priced.value.commission.minor + priced.value.sellerNet.minor).toBe(
      priced.value.subtotal.minor,
    );
  });

  /**
   * A cart with two sellers becomes two orders, so it also pays two parcels. One flat rate
   * for two shipments would make the quoted total smaller than the sum of the receipts.
   */
  it('charges one postage per seller', () => {
    const priced = priceCart(
      request([
        { listingId: 'l1', quantity: 1 },
        { listingId: 'l2', quantity: 1 },
      ]),
    );
    if (!priced.ok) throw new Error('expected a price');

    expect(priced.value.shipping.minor).toBe(12_000);
    expect(priced.value.total.minor).toBe(25_000 + 9_900 + 12_000);
  });

  it('charges one postage for a cart from a single seller', () => {
    const priced = priceCart(request([{ listingId: 'l1', quantity: 3 }]));
    if (!priced.ok) throw new Error('expected a price');
    expect(priced.value.shipping.minor).toBe(6_000);
  });

  it('refuses an empty cart', () => {
    expect(priceCart(request([]))).toEqual({ ok: false, error: { code: 'EMPTY_CART' } });
  });

  it('refuses more than the available stock, and says how much there is', () => {
    expect(priceCart(request([{ listingId: 'l2', quantity: 3 }]))).toEqual({
      ok: false,
      error: { code: 'NOT_ENOUGH_STOCK', listingId: 'l2', available: 2 },
    });
  });

  it('refuses a listing that is not buyable', () => {
    const withDraft = {
      ...request([{ listingId: 'l3', quantity: 1 }]),
      listings: listingsOf(listing({ id: 'l3', status: 'DRAFT' })),
    };
    expect(priceCart(withDraft)).toEqual({
      ok: false,
      error: { code: 'LISTING_NOT_BUYABLE', listingId: 'l3' },
    });
  });

  it('refuses the same listing on two lines, which would bypass the quantity cap', () => {
    expect(
      priceCart(
        request([
          { listingId: 'l1', quantity: 1 },
          { listingId: 'l1', quantity: 1 },
        ]),
      ),
    ).toEqual({ ok: false, error: { code: 'TOO_MANY_OF_ONE_ITEM', limit: MAX_QUANTITY_PER_LINE } });
  });

  it('refuses more than the per-line quantity cap', () => {
    const big = {
      ...request([{ listingId: 'l1', quantity: MAX_QUANTITY_PER_LINE + 1 }]),
      listings: listingsOf(listing({ id: 'l1', stock: 100 })),
    };
    expect(priceCart(big).ok).toBe(false);
  });

  it('refuses a zero quantity rather than pricing it at nothing', () => {
    expect(priceCart(request([{ listingId: 'l1', quantity: 0 }])).ok).toBe(false);
  });

  it('refuses a cart mixing currencies instead of picking a rate', () => {
    expect(
      priceCart({
        ...request([
          { listingId: 'l1', quantity: 1 },
          { listingId: 'l4', quantity: 1 },
        ]),
        listings: listingsOf(
          listing({ id: 'l1' }),
          listing({ id: 'l4', price: { currency: 'USD', minor: 2_000 } }),
        ),
      }),
    ).toEqual({ ok: false, error: { code: 'CURRENCY_MISMATCH' } });
  });

  it('refuses a commission above the platform ceiling', () => {
    expect(
      priceCart(request([{ listingId: 'l1', quantity: 1 }], { commissionBps: 9_000 })),
    ).toEqual({
      ok: false,
      error: { code: 'COMMISSION_REFUSED' },
    });
  });

  it('checks a quoted total against the computed one', () => {
    const priced = priceCart(request([{ listingId: 'l1', quantity: 1 }]));
    if (!priced.ok) throw new Error('expected a price');

    expect(checkTotal({ currency: 'BDT', minor: 31_000 }, priced.value)).toBeNull();
    expect(checkTotal({ currency: 'BDT', minor: 30_000 }, priced.value)).toEqual({
      code: 'TOTAL_MISMATCH',
      expected: 31_000,
      actual: 30_000,
    });
  });
});

describe('order states', () => {
  it('lets a buyer reserve and cancel, but not expire', () => {
    expect(decideOrderMove('PENDING', 'RESERVED', 'BUYER').ok).toBe(true);
    expect(decideOrderMove('PENDING', 'CANCELLED', 'BUYER').ok).toBe(true);
    expect(decideOrderMove('PENDING', 'EXPIRED', 'BUYER').ok).toBe(false);
    expect(decideOrderMove('PENDING', 'EXPIRED', 'PLATFORM').ok).toBe(true);
  });

  /** Payment approval is the platform's, not the buyer's: the buyer does not confirm money. */
  it('only lets the platform mark an order paid', () => {
    expect(decideOrderMove('RESERVED', 'PAID', 'BUYER').ok).toBe(false);
    expect(decideOrderMove('RESERVED', 'PAID', 'PLATFORM').ok).toBe(true);
  });

  it('reports whether the target state holds stock', () => {
    const reserved = decideOrderMove('PENDING', 'RESERVED', 'BUYER');
    expect(reserved).toEqual({ ok: true, value: { holdsStock: true } });

    const paid = decideOrderMove('RESERVED', 'PAID', 'PLATFORM');
    expect(paid).toEqual({ ok: true, value: { holdsStock: false } });
  });

  it('refuses a payment for an order whose stock was already released', () => {
    expect(canMoveOrder('PENDING', 'PAID')).toBe(false);
    expect(canMoveOrder('CANCELLED', 'PAID')).toBe(false);
    expect(canMoveOrder('EXPIRED', 'PAID')).toBe(false);
  });

  it('refuses a refund that was never paid for', () => {
    expect(canMoveOrder('PENDING', 'REFUNDED')).toBe(false);
    expect(canMoveOrder('CANCELLED', 'REFUNDED')).toBe(false);
    expect(canMoveOrder('PAID', 'REFUNDED')).toBe(true);
    expect(canMoveOrder('SHIPPED', 'REFUNDED')).toBe(true);
    expect(canMoveOrder('DELIVERED', 'REFUNDED')).toBe(false);
  });

  it('lets only the seller ship', () => {
    expect(decideOrderMove('PAID', 'SHIPPED', 'SELLER').ok).toBe(true);
    expect(decideOrderMove('PAID', 'SHIPPED', 'BUYER').ok).toBe(false);
    expect(decideOrderMove('PAID', 'SHIPPED', 'PLATFORM').ok).toBe(false);
  });

  it('knows which states are terminal', () => {
    expect(isTerminal('DELIVERED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('PAID')).toBe(false);
  });

  it('expires a hold after the window and not before', () => {
    const start = new Date('2026-11-21T10:00:00.000Z');
    const expiresAt = new Date(start.getTime() + reservationWindowMs);

    expect(RESERVATION_MINUTES).toBe(30);
    expect(isExpired({ now: start, expiresAt })).toBe(false);
    expect(isExpired({ now: new Date(start.getTime() + reservationWindowMs - 1), expiresAt })).toBe(
      false,
    );
    expect(isExpired({ now: expiresAt, expiresAt })).toBe(true);
  });

  it('orders the timeline by time, not by the order the rows arrived in', () => {
    const entries = [
      {
        status: 'PAID' as const,
        at: new Date('2026-11-21T12:00:00.000Z'),
        actor: 'PLATFORM' as const,
      },
      {
        status: 'RESERVED' as const,
        at: new Date('2026-11-21T11:00:00.000Z'),
        actor: 'BUYER' as const,
      },
    ];
    expect(timelineOf(entries).map((entry) => entry.status)).toEqual(['RESERVED', 'PAID']);
  });
});

describe('refunds', () => {
  it('returns the goods and the commission, never the postage', () => {
    const refund = computeRefund(
      { currency: 'BDT', minor: 50_000 },
      { currency: 'BDT', minor: 5_000 },
    );
    expect(refund).toEqual({
      ok: true,
      value: {
        refunded: { currency: 'BDT', minor: 50_000 },
        commissionReturned: { currency: 'BDT', minor: 5_000 },
      },
    });
  });

  it('refuses a refund across two currencies', () => {
    expect(
      computeRefund({ currency: 'BDT', minor: 50_000 }, { currency: 'USD', minor: 500 }),
    ).toEqual({ ok: false, error: { code: 'CURRENCY_MISMATCH' } });
  });
});
