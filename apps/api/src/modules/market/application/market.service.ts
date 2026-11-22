/**
 * Market use cases.
 *
 * The policy lives in the kernel (`canMoveListing`, `priceCart`, `decideOrderMove`,
 * `computeRefund`, `checkTotal`). This service assembles what those functions need, refuses
 * when they say no, and adds the two things a pure function cannot know: **who is asking**,
 * and **what the stock currently is**.
 *
 * Four decisions worth stating:
 *
 * 1. **A cart is split by seller.** One order has one seller, one shipment and one payout;
 *    a cart with two sellers becomes two orders, and the response is the list. Merging them
 *    would mean a single order whose refund and shipping cannot be reasoned about.
 * 2. **Reserving stock happens before the order row is written, and in the same request.**
 *    A hold that is written after the order exists is a moment in which the order is real
 *    and the stock is not — and a crash there oversells.
 * 3. **A quoted total is compared, not trusted.** If the cart the buyer saw no longer prices
 *    the same, the answer is `409` with the new total, never a silent charge of the new one.
 * 4. **The actions a caller may take are computed for that caller.** `availableActions` on
 *    the response means the UI never draws a button the state machine would refuse.
 */

import { Inject, Injectable } from '@nestjs/common';

import {
  appError,
  availableOf,
  canMoveListing,
  checkListingForSale,
  checkTotal,
  computeRefund,
  decideOrderMove,
  priceCart,
  slugFor,
  type Listing as KernelListing,
  type OrderStatus,
} from '@socialhub/kernel';
import type {
  CheckoutRequest,
  OrderAction,
  CreateListingRequest,
  ListingListResponse,
  ListingQuery,
  ListingResponse,
  ListingSummaryResponse,
  OrderActionRequest,
  OrderQuery,
  OrderResponse,
  UpdateListingRequest,
} from '@socialhub/contracts';

import { DomainException } from '../../../common/filters/domain-exception.js';
import type { Clock, IdGenerator } from '../../auth/application/ports.js';
import { CLOCK, IDS } from '../../auth/auth.tokens.js';
import type { ListingRecord, ListingStore, OrderRecord, OrderStore } from './ports.js';
import { LISTING_STORE, ORDER_STORE } from '../market.tokens.js';

/** Flat postage for now: one rate per order, stored on the order so a receipt keeps it. */
export const SHIPPING_MINOR = 6_000;
export const COMMISSION_BPS = 1_000;

type OrderMove = {
  readonly from: readonly OrderStatus[];
  readonly to: OrderStatus;
  /** Who performs the move — the actor the state machine checks. */
  readonly actor: 'BUYER' | 'SELLER' | 'PLATFORM';
  /** Who may ask for it, which is not always the same party. */
  readonly requestedBy: 'BUYER' | 'SELLER';
};

const MOVE_FOR_ACTION: Readonly<Record<OrderAction, OrderMove>> = {
  CANCEL: { from: ['PENDING', 'RESERVED'], to: 'CANCELLED', actor: 'BUYER', requestedBy: 'BUYER' },
  SHIP: { from: ['PAID'], to: 'SHIPPED', actor: 'SELLER', requestedBy: 'SELLER' },
  DELIVER: { from: ['SHIPPED'], to: 'DELIVERED', actor: 'SELLER', requestedBy: 'SELLER' },
  REFUND: { from: ['PAID', 'SHIPPED'], to: 'REFUNDED', actor: 'PLATFORM', requestedBy: 'SELLER' },
};

/**
 * A total lookup.
 *
 * `noUncheckedIndexedAccess` makes `MOVE_FOR_ACTION[action]` a `OrderMove | undefined` even
 * for a keyed union, which would put a `!` at four call sites. The helper states once that
 * every action in the contract has a move, and falls back to cancelling rather than crashing
 * if a future action is added to the contract and forgotten here.
 */
const moveFor = (action: OrderAction): OrderMove =>
  MOVE_FOR_ACTION[action] ?? MOVE_FOR_ACTION.CANCEL;

@Injectable()
export class MarketService {
  public constructor(
    @Inject(LISTING_STORE) private readonly listings: ListingStore,
    @Inject(ORDER_STORE) private readonly orders: OrderStore,
    @Inject(IDS) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /* ------------------------------------------------------------------------- listings */

  private toSummary(listing: ListingRecord, viewerId: string): ListingSummaryResponse {
    return {
      id: listing.id,
      slug: listing.slug,
      title: listing.title,
      priceMinor: listing.priceMinor,
      currency: listing.currency as ListingSummaryResponse['currency'],
      stock: listing.stock,
      available: availableOf({
        id: listing.id,
        sellerId: listing.sellerId,
        status: listing.status,
        price: { currency: listing.currency as 'BDT', minor: listing.priceMinor },
        stock: listing.stock,
        reserved: listing.reservedStock,
      }),
      status: listing.status,
      seller: listing.seller,
      isSeller: listing.sellerId === viewerId,
      createdAt: listing.createdAt.toISOString(),
      updatedAt: listing.updatedAt.toISOString(),
    };
  }

  private toListing(listing: ListingRecord, viewerId: string): ListingResponse {
    return { ...this.toSummary(listing, viewerId), description: listing.description };
  }

  public async listListings(viewerId: string, query: ListingQuery): Promise<ListingListResponse> {
    const page = await this.listings.list({
      viewerId,
      limit: query.limit,
      cursor: query.cursor ?? null,
      search: query.q ?? null,
      sellerUsername: query.seller ?? null,
      mine: query.mine,
    });

    const last = page.items[page.items.length - 1];
    const nextCursor =
      last === undefined || page.items.length < query.limit
        ? null
        : `${last.createdAt.toISOString()}|${last.id}`;

    return {
      items: page.items.map((listing) => this.toSummary(listing, viewerId)),
      nextCursor,
    };
  }

  public async listing(viewerId: string, idOrSlug: string): Promise<ListingResponse> {
    const found = await this.listings.find(viewerId, idOrSlug);
    if (found === null) throw new DomainException(appError('NOT_FOUND', 'Listing not found'));
    return this.toListing(found, viewerId);
  }

  public async createListing(
    sellerId: string,
    input: CreateListingRequest,
  ): Promise<ListingResponse> {
    const refusal = checkListingForSale(input.status, input.price, input.stock);
    if (refusal !== null)
      throw new DomainException(appError('VALIDATION_FAILED', this.messageFor(refusal.code)));

    const now = this.clock();
    // The id is the uniqueness token for the fallback, so a retried create derives the
    // same URL rather than leaking a second slug.
    const id = this.ids.next();
    const slug = input.slug ?? slugFor(input.title, id.replaceAll('-', '').slice(-12));

    // Checked before the insert so the seller hears *why*; the store answers `null` for the
    // race the check cannot close, which is the same `409`.
    if (await this.listings.slugTaken(slug)) {
      throw new DomainException(appError('CONFLICT', 'That URL is already taken'));
    }

    const created = await this.listings.create({
      id,
      sellerId,
      seller: { accountId: sellerId, username: '', displayName: '', avatarKey: null },
      slug,
      title: input.title,
      description: input.description ?? '',
      priceMinor: input.price,
      currency: input.currency,
      stock: input.stock,
      reservedStock: 0,
      status: input.status,
      createdAt: now,
      updatedAt: now,
    });

    if (created === null) {
      throw new DomainException(appError('CONFLICT', 'That URL is already taken'));
    }

    return this.toListing(created, sellerId);
  }

  public async updateListing(
    sellerId: string,
    id: string,
    input: UpdateListingRequest,
  ): Promise<ListingResponse> {
    const existing = await this.listings.findById(id);
    if (existing === null || existing.sellerId !== sellerId) {
      // `404`, not `403`: another seller's draft is not disclosed, and the same answer is
      // what a listing that never existed returns.
      throw new DomainException(appError('NOT_FOUND', 'Listing not found'));
    }

    const nextStatus = input.status ?? existing.status;
    if (input.status !== undefined && !canMoveListing(existing.status, input.status)) {
      throw new DomainException(
        appError('PRECONDITION_FAILED', 'A withdrawn listing cannot be brought back'),
      );
    }

    const refusal = checkListingForSale(
      nextStatus,
      input.price ?? existing.priceMinor,
      input.stock ?? existing.stock,
    );
    if (refusal !== null)
      throw new DomainException(appError('VALIDATION_FAILED', this.messageFor(refusal.code)));

    const updated = await this.listings.update(sellerId, id, {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.price === undefined ? {} : { priceMinor: input.price }),
      ...(input.stock === undefined ? {} : { stock: input.stock }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });

    if (updated === null) throw new DomainException(appError('NOT_FOUND', 'Listing not found'));
    return this.toListing(updated, sellerId);
  }

  public async removeListing(sellerId: string, id: string): Promise<void> {
    const existing = await this.listings.findById(id);
    if (existing === null || existing.sellerId !== sellerId) {
      throw new DomainException(appError('NOT_FOUND', 'Listing not found'));
    }

    const removed = await this.listings.remove(sellerId, id);
    if (!removed) {
      throw new DomainException(
        appError('CONFLICT', 'That listing has orders; withdraw it instead of deleting it'),
      );
    }
  }

  /* -------------------------------------------------------------------------- checkout */

  public async checkout(buyerId: string, input: CheckoutRequest): Promise<OrderResponse[]> {
    // 1. Load every listing once, and price the cart with the kernel's rule.
    const records = new Map<string, ListingRecord>();
    for (const line of input.lines) {
      const found = await this.listings.findById(line.listingId);
      if (found !== null) records.set(found.id, found);
    }

    const kernelListings = new Map<string, KernelListing>(
      [...records.values()].map((listing) => [
        listing.id,
        {
          id: listing.id,
          sellerId: listing.sellerId,
          status: listing.status,
          price: { currency: listing.currency as 'BDT', minor: listing.priceMinor },
          stock: listing.stock,
          reserved: listing.reservedStock,
        },
      ]),
    );

    const priced = priceCart({
      lines: input.lines,
      listings: kernelListings,
      shippingMinor: SHIPPING_MINOR,
      commissionBps: COMMISSION_BPS,
    });

    if (!priced.ok) {
      throw new DomainException(
        appError(
          priced.error.code === 'NOT_ENOUGH_STOCK' || priced.error.code === 'LISTING_NOT_BUYABLE'
            ? 'CONFLICT'
            : 'VALIDATION_FAILED',
          this.messageFor(priced.error.code, priced.error),
        ),
      );
    }

    if (input.lines.some((line) => records.get(line.listingId)?.sellerId === buyerId)) {
      throw new DomainException(appError('VALIDATION_FAILED', 'You cannot buy your own listing'));
    }

    // 2. Compare what the buyer was shown with what the cart costs now. This is the whole
    //    reason the quoted total travels with the request.
    const quoted = { currency: priced.value.total.currency, minor: input.quotedTotalMinor };
    const mismatch = checkTotal(quoted, priced.value);
    if (mismatch !== null) {
      throw new DomainException(
        appError(
          'CONFLICT',
          `The price changed while you were checking out — it is now ${priced.value.total.minor}`,
        ),
      );
    }

    // 3. Reserve, seller by seller. A failure releases everything already held, or one
    //    buyer's failed checkout would hold another buyer's stock for half an hour.
    const groups = new Map<string, typeof priced.value.lines>();
    for (const line of priced.value.lines) {
      const sellerId = records.get(line.listingId)?.sellerId;
      if (sellerId === undefined) continue;
      const group = groups.get(sellerId) ?? [];
      groups.set(sellerId, [...group, line]);
    }

    const held: { listingId: string; quantity: number }[] = [];
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + 30 * 60_000);
    const created: OrderResponse[] = [];

    try {
      for (const [sellerId, lines] of groups) {
        for (const line of lines) {
          const reserved = await this.listings.reserve(line.listingId, line.quantity);
          if (!reserved) {
            throw new DomainException(
              appError('CONFLICT', 'Someone else bought it while it was in your cart'),
            );
          }
          held.push({ listingId: line.listingId, quantity: line.quantity });
        }

        const subtotal = lines.reduce((total, line) => total + line.lineTotal.minor, 0);
        const shipping = SHIPPING_MINOR;
        const commission = Math.round((subtotal * COMMISSION_BPS) / 10_000);

        const order = await this.orders.create({
          id: this.ids.next(),
          buyerId,
          sellerId,
          status: 'RESERVED',
          items: lines.map((line) => ({
            listingId: line.listingId,
            title: records.get(line.listingId)?.title ?? '',
            unitPriceMinor: line.unitPrice.minor,
            quantity: line.quantity,
          })),
          subtotalMinor: subtotal,
          shippingMinor: shipping,
          commissionMinor: commission,
          totalMinor: subtotal + shipping,
          currency: priced.value.total.currency,
          shippingAddress: input.shippingAddress,
          contactPhone: input.contactPhone ?? null,
          expiresAt,
          createdAt: now,
        });

        created.push(this.toOrder(order, buyerId));
      }
    } catch (error) {
      // Undo every hold this request made before rethrowing.
      for (const hold of held) {
        await this.listings.release(hold.listingId, hold.quantity);
      }
      throw error;
    }

    return created;
  }

  /* ---------------------------------------------------------------------------- orders */

  private toOrder(order: OrderRecord, viewerId: string): OrderResponse {
    const isBuyer = order.buyerId === viewerId;
    const isSeller = order.sellerId === viewerId;

    const availableActions: OrderAction[] = [];
    for (const action of ['CANCEL', 'SHIP', 'DELIVER', 'REFUND'] as const) {
      const move = moveFor(action);
      if (!move.from.includes(order.status as OrderStatus)) continue;
      const permitted =
        (move.actor === 'BUYER' && isBuyer) ||
        (move.actor === 'SELLER' && isSeller) ||
        move.actor === 'PLATFORM';

      // A buyer never sees `REFUND`: it is the platform's move, offered on request. The
      // button belongs on a support flow, not on the order row.
      if (action === 'REFUND' && !isSeller) continue;
      if (permitted) availableActions.push(action);
    }

    return {
      id: order.id,
      status: order.status as OrderStatus,
      items: order.items.map((item) => ({
        ...item,
        lineTotalMinor: item.unitPriceMinor * item.quantity,
      })),
      subtotalMinor: order.subtotalMinor,
      shippingMinor: order.shippingMinor,
      commissionMinor: order.commissionMinor,
      totalMinor: order.totalMinor,
      currency: order.currency as OrderResponse['currency'],
      shippingAddress: order.shippingAddress,
      contactPhone: order.contactPhone,
      buyer: order.buyer,
      seller: order.seller,
      isBuyer,
      isSeller,
      availableActions,
      timeline: order.timeline.map((event) => ({
        status: event.status as OrderStatus,
        actor: event.actor,
        at: event.at.toISOString(),
      })),
      expiresAt: order.expiresAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
    };
  }

  public async listOrders(
    viewerId: string,
    query: OrderQuery,
  ): Promise<{ items: OrderResponse[]; nextCursor: string | null }> {
    const page = await this.orders.list({
      viewerId,
      limit: query.limit,
      cursor: query.cursor ?? null,
      role: query.role,
      status: query.status ?? null,
    });

    const last = page.items[page.items.length - 1];
    const nextCursor =
      last === undefined || page.items.length < query.limit
        ? null
        : `${last.createdAt.toISOString()}|${last.id}`;

    return { items: page.items.map((order) => this.toOrder(order, viewerId)), nextCursor };
  }

  public async order(viewerId: string, id: string): Promise<OrderResponse> {
    const found = await this.orders.find(viewerId, id);
    if (found === null) throw new DomainException(appError('NOT_FOUND', 'Order not found'));
    return this.toOrder(found, viewerId);
  }

  /**
   * A named action on an order.
   *
   * The actor is derived from who is asking, never from the request: a seller cannot send
   * `actor: 'PLATFORM'` and refund themselves.
   */
  public async actOnOrder(
    viewerId: string,
    id: string,
    input: OrderActionRequest,
  ): Promise<OrderResponse> {
    const existing = await this.orders.find(viewerId, id);
    if (existing === null) throw new DomainException(appError('NOT_FOUND', 'Order not found'));

    const move = moveFor(input.action);
    const requester: 'BUYER' | 'SELLER' = existing.buyerId === viewerId ? 'BUYER' : 'SELLER';

    // Who may ask for a move is a separate question from who performs it. A buyer cannot
    // ship; a seller cannot cancel a buyer's order out from under them. A refund is asked
    // for by the seller and *performed* by the platform, so the requester is checked here
    // and the acting party is taken from the state machine.
    if (move.requestedBy !== requester) {
      throw new DomainException(
        appError('PRECONDITION_FAILED', this.messageFor('INVALID_TRANSITION', null)),
      );
    }

    // The money moves from an escrow account the seller does not hold, so the recorded
    // actor for a refund is the platform even though the seller asked for it.
    const decision = decideOrderMove(existing.status as OrderStatus, move.to, move.actor);
    if (!decision.ok) {
      throw new DomainException(
        appError('PRECONDITION_FAILED', this.messageFor('INVALID_TRANSITION', decision.error)),
      );
    }

    const recorded: 'BUYER' | 'SELLER' | 'PLATFORM' = move.actor;
    const updated = await this.orders.setStatus(
      id,
      existing.status,
      move.to,
      recorded,
      this.clock(),
    );

    // A lost race is a `409`, not a silent second success: somebody else moved the order
    // while this request was in flight.
    if (updated === null) {
      throw new DomainException(
        appError('CONFLICT', 'That order moved while you were acting on it'),
      );
    }

    // Returned goods go back on the shelf. `release` alone would leave the stock sold.
    if (move.to === 'REFUNDED') {
      for (const item of existing.items) {
        await this.listings.restock(item.listingId, item.quantity);
      }
    }

    if (move.to === 'CANCELLED' || move.to === 'EXPIRED') {
      for (const item of existing.items) {
        await this.listings.release(item.listingId, item.quantity);
      }
    }

    if (move.to === 'PAID') {
      // A hold becomes a sale: stock and the reserve both fall. Nothing in the current HTTP
      // surface reaches this state — it belongs to the payment callback — but the branch is
      // what the state machine's `RESERVED -> PAID` is for.
      for (const item of existing.items) {
        await this.listings.consume(item.listingId, item.quantity);
      }
    }

    return this.toOrder(updated, viewerId);
  }

  /** What a refund would return, so a support screen can quote a number before it acts. */
  public refundPreview(
    order: OrderRecord,
  ): { refunded: number; commissionReturned: number } | null {
    const refund = computeRefund(
      { currency: order.currency as 'BDT', minor: order.subtotalMinor },
      { currency: order.currency as 'BDT', minor: order.commissionMinor },
    );
    return refund.ok
      ? {
          refunded: refund.value.refunded.minor,
          commissionReturned: refund.value.commissionReturned.minor,
        }
      : null;
  }

  private messageFor(code: string, detail?: unknown): string {
    switch (code) {
      case 'NOTHING_TO_SELL':
        return 'A listing that is on sale needs at least one unit';
      case 'PRICE_TOO_LOW':
        return 'The lowest price is 1.00';
      case 'EMPTY_CART':
        return 'Your cart is empty';
      case 'NOT_ENOUGH_STOCK':
        return 'Someone else bought it while it was in your cart';
      case 'LISTING_NOT_BUYABLE':
        return 'That item is no longer for sale';
      case 'CURRENCY_MISMATCH':
        return 'Your cart mixes currencies';
      case 'TOO_MANY_OF_ONE_ITEM':
        return 'That is more of one item than we allow';
      case 'COMMISSION_REFUSED':
        return 'That commission rate is not allowed';
      default:
        void detail;
        return 'That order cannot move there yet';
    }
  }
}

/** The order column is `text`; the kernel's currency type is narrower. */
