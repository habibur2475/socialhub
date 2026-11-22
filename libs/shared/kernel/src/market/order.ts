/**
 * Market — the order lifecycle.
 *
 * An order is the point where money, stock and trust meet, so its states are a state
 * machine with one rule that shapes everything else: **an unpaid order holds stock but does
 * not sell it.** The hold is what stops two buyers paying for the same last unit, and it is
 * why `RESERVED` exists as a state between "the buyer pressed pay" and "the money arrived".
 *
 * The transitions are asymmetric on purpose:
 *
 *   * `PAID` is reachable only from `RESERVED`, never from `PENDING` — a payment for an order
 *     whose stock was already released is a payment for something that may no longer exist.
 *   * A cancelled or expired order releases its hold; a paid one does not.
 *   * `REFUNDED` is terminal and reachable only from `PAID` or `SHIPPED`. A refund for an
 *     order that was never paid is not a refund, it is a mistake in a reconciliation report.
 */

import { type Result, fail, ok } from '../result.js';
import type { Money } from '../money.js';

export type OrderStatus =
  | 'PENDING'
  | 'RESERVED'
  | 'PAID'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REFUNDED';

export const ORDER_STATUSES: readonly OrderStatus[] = [
  'PENDING',
  'RESERVED',
  'PAID',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
];

/** What the buyer sees, in one word. */
export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  PENDING: 'Awaiting payment',
  RESERVED: 'Payment processing',
  PAID: 'Paid',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  REFUNDED: 'Refunded',
};

const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING: ['RESERVED', 'CANCELLED', 'EXPIRED'],
  RESERVED: ['PAID', 'CANCELLED', 'EXPIRED'],
  PAID: ['SHIPPED', 'REFUNDED'],
  SHIPPED: ['DELIVERED', 'REFUNDED'],
  DELIVERED: [],
  CANCELLED: [],
  EXPIRED: [],
  REFUNDED: [],
};

/** States in which the order's stock is held against other buyers. */
export const HOLDS_STOCK: readonly OrderStatus[] = ['RESERVED'];

/** States in which money has changed hands and not yet come back. */
export const SETTLED_STATES: readonly OrderStatus[] = ['PAID', 'SHIPPED', 'DELIVERED'];

export const isTerminal = (status: OrderStatus): boolean => TRANSITIONS[status].length === 0;

export const canMoveOrder = (from: OrderStatus, to: OrderStatus): boolean =>
  TRANSITIONS[from].includes(to);

export type OrderRefusal =
  | { readonly code: 'INVALID_TRANSITION'; readonly from: OrderStatus; readonly to: OrderStatus }
  | { readonly code: 'NOT_YOUR_ORDER' }
  | { readonly code: 'ORDER_ALREADY_TERMINAL'; readonly status: OrderStatus };

/**
 * Decides a move.
 *
 * `actor` is the buyer, the seller, or the platform. The rule is not "the buyer may cancel"
 * in a boolean: cancelling is the buyer's, shipping and delivering are the seller's, and a
 * refund is the platform's because it is the only one that moves money back. Putting the
 * matrix here means a route cannot grant itself a permission the state machine denies.
 */
export type OrderActor = 'BUYER' | 'SELLER' | 'PLATFORM';

const PERMITTED: Readonly<Record<OrderStatus, Partial<Record<OrderStatus, OrderActor>>>> = {
  PENDING: { RESERVED: 'BUYER', CANCELLED: 'BUYER', EXPIRED: 'PLATFORM' },
  RESERVED: { PAID: 'PLATFORM', CANCELLED: 'BUYER', EXPIRED: 'PLATFORM' },
  PAID: { SHIPPED: 'SELLER', REFUNDED: 'PLATFORM' },
  SHIPPED: { DELIVERED: 'SELLER', REFUNDED: 'PLATFORM' },
  DELIVERED: {},
  CANCELLED: {},
  EXPIRED: {},
  REFUNDED: {},
};

export const decideOrderMove = (
  from: OrderStatus,
  to: OrderStatus,
  actor: OrderActor,
): Result<{ readonly holdsStock: boolean }, OrderRefusal> => {
  const allowed = PERMITTED[from][to];
  if (allowed === undefined) return fail({ code: 'INVALID_TRANSITION', from, to });

  // A refund is the platform's act even when the seller asked for it: the seller can
  // request one, but the money moves from an escrow account the seller does not hold.
  if (allowed !== actor) return fail({ code: 'INVALID_TRANSITION', from, to });

  return ok({ holdsStock: HOLDS_STOCK.includes(to) });
};

/** How long an unpaid order holds stock before the sweeper releases it. */
export const RESERVATION_MINUTES = 30;

export type ReservationClock = {
  readonly now: Date;
  readonly expiresAt: Date;
};

export const isExpired = (clock: ReservationClock): boolean =>
  clock.now.getTime() >= clock.expiresAt.getTime();

/** Milliseconds an order may hold stock, from the moment it was reserved. */
export const reservationWindowMs = RESERVATION_MINUTES * 60_000;

export type OrderTimelineEntry = {
  readonly status: OrderStatus;
  readonly at: Date;
  readonly actor: OrderActor;
};

/**
 * The timeline a buyer sees.
 *
 * It is derived from the stored moves rather than from the current status, because
 * "Shipped" with no date is a sentence a buyer cannot act on. The one thing it does *not*
 * do is invent a move: an order whose history is empty renders as empty, and the service
 * refuses to fabricate a first row.
 */
export const timelineOf = (entries: readonly OrderTimelineEntry[]): readonly OrderTimelineEntry[] =>
  [...entries].sort((left, right) => left.at.getTime() - right.at.getTime());

export type RefundResult = {
  readonly refunded: Money;
  /** Commission returned to the seller along with the goods value. */
  readonly commissionReturned: Money;
};

/**
 * A refund returns the goods value and the commission on it, but **never the shipping**:
 * the courier has already been paid, and a platform that refunds postage it does not get
 * back is a platform that loses money on every return.
 */
export const computeRefund = (
  subtotal: Money,
  commission: Money,
): Result<RefundResult, { readonly code: 'CURRENCY_MISMATCH' }> => {
  if (subtotal.currency !== commission.currency) return fail({ code: 'CURRENCY_MISMATCH' });

  return ok({
    refunded: subtotal,
    commissionReturned: commission,
  });
};
