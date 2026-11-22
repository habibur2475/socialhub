/**
 * Market contracts.
 *
 * Four boundaries, each with one job:
 *
 *   the *listing*     what a seller writes and a buyer reads: title, description, price,
 *                     stock. The price is a **decimal string** on the wire, never a JSON
 *                     number — `0.1 + 0.2` in a client-side cart is exactly the bug the
 *                     integer-minor-unit rule exists to prevent, and a JSON number is a
 *                     double the moment it is parsed.
 *   the *checkout*    what a buyer sends to turn a cart into an order: lines, an address,
 *                     and the **total they were quoted**. Sending the quoted total is not
 *                     redundant: it is how the server proves the cart the buyer saw is the
 *                     cart it is charging for.
 *   the *move*        a named transition (`SHIP`, `CANCEL`, …) rather than a status field, so
 *                     the route cannot be used to write an arbitrary status.
 *   the *query*       keyset paging, a seller filter, and the buyer/seller split.
 */

import { z } from 'zod';

export const LISTING_STATUSES = ['DRAFT', 'ACTIVE', 'SOLD_OUT', 'WITHDRAWN'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const ORDER_STATUSES = [
  'PENDING',
  'RESERVED',
  'PAID',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const MARKET_CURRENCIES = ['BDT', 'USD', 'EUR', 'GBP', 'INR'] as const;
export type MarketCurrency = (typeof MARKET_CURRENCIES)[number];

export const MAX_CART_LINES = 20;
export const MAX_QUANTITY_PER_LINE = 20;

const PRICE_PATTERN = /^\d{1,9}(\.\d{1,2})?$/u;

/**
 * A price as a person types it.
 *
 * The pattern refuses `1.234` (more precision than paisa), `1e5` and a leading `+`. The
 * transform then produces the integer minor units, so every consumer downstream — the
 * kernel, the database, the receipt — works with the same exact number.
 */
const priceSchema = z
  .string()
  .trim()
  .regex(PRICE_PATTERN, 'A price like 250 or 250.50')
  .transform((value) => {
    const [whole = '0', fraction = ''] = value.split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  })
  .refine((minor) => minor >= 100, 'The lowest price is 1.00')
  .refine((minor) => minor <= 100_000_000, 'That price is too high');

const slugSchema = z
  .string()
  .trim()
  .min(3)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u, 'Lowercase letters, digits and single hyphens');

export const createListingRequestSchema = z
  .object({
    title: z.string().trim().min(3, 'A title needs at least 3 characters').max(120),
    description: z.string().max(4_000).optional(),
    price: priceSchema,
    currency: z.enum(MARKET_CURRENCIES).default('BDT'),
    stock: z.coerce.number().int().min(0).max(10_000),
    /** A listing saved as a draft may hold no stock yet; going live needs some. */
    status: z.enum(['DRAFT', 'ACTIVE']).default('DRAFT'),
    slug: slugSchema.optional(),
  })
  .strict();

/**
 * The parsed request — `price` is already in minor units. This is what the service sees.
 */
export type CreateListingRequest = z.infer<typeof createListingRequestSchema>;

/**
 * The request **as it arrives**: `price` is still the decimal string a person typed.
 *
 * Both types exist because the transform is the whole point: a client sends a string and the
 * server works in integers. Collapsing them would make a client send a float, which is the
 * bug the transform prevents.
 */
export type CreateListingRequestInput = z.input<typeof createListingRequestSchema>;

export const updateListingRequestSchema = z
  .object({
    title: z.string().trim().min(3).max(120).optional(),
    description: z.string().max(4_000).optional(),
    price: priceSchema.optional(),
    stock: z.coerce.number().int().min(0).max(10_000).optional(),
    status: z.enum(LISTING_STATUSES).optional(),
  })
  .strict()
  .refine(
    (patch) =>
      patch.title !== undefined ||
      patch.description !== undefined ||
      patch.price !== undefined ||
      patch.stock !== undefined ||
      patch.status !== undefined,
    'Nothing to change',
  );

export type UpdateListingRequest = z.infer<typeof updateListingRequestSchema>;
export type UpdateListingRequestInput = z.input<typeof updateListingRequestSchema>;

/** A named action, because `PATCH { status }` would be a second way in with no state machine. */
export const ORDER_ACTIONS = ['CANCEL', 'REFUND', 'SHIP', 'DELIVER'] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];

export const orderActionRequestSchema = z
  .object({
    action: z.enum(ORDER_ACTIONS),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type OrderActionRequest = z.infer<typeof orderActionRequestSchema>;

export const checkoutRequestSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            listingId: z.string().uuid(),
            quantity: z.coerce.number().int().min(1).max(MAX_QUANTITY_PER_LINE),
          })
          .strict(),
      )
      .min(1, 'A cart needs at least one item')
      .max(MAX_CART_LINES),
    shippingAddress: z.string().trim().min(10, 'A full address, please').max(500),
    contactPhone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{6,20}$/u, 'A phone number we can call')
      .optional(),
    /**
     * What the buyer was shown. The server recomputes the cart and compares, so a price
     * that changed between the page and the request is a `409` rather than a silent charge.
     */
    quotedTotalMinor: z.coerce.number().int().min(0),
  })
  .strict();

export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

export const listingQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(120).optional(),
    /** A prefix match on the title, case-folded. */
    q: z.string().trim().max(80).optional(),
    /** Only this seller's listings, and only that seller may ask for `DRAFT`. */
    seller: z.string().trim().min(2).max(40).optional(),
    mine: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export type ListingQuery = z.infer<typeof listingQuerySchema>;

export const orderQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(120).optional(),
    /** `BUYING` is the default: most people open their orders to see what they bought. */
    role: z.enum(['BUYING', 'SELLING']).default('BUYING'),
    status: z.enum(ORDER_STATUSES).optional(),
  })
  .strict();

export type OrderQuery = z.infer<typeof orderQuerySchema>;

export type SellerSummaryResponse = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
};

export type ListingSummaryResponse = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly priceMinor: number;
  readonly currency: MarketCurrency;
  readonly stock: number;
  /** Stock minus what unpaid orders hold. What a buyer may add to a cart. */
  readonly available: number;
  readonly status: ListingStatus;
  readonly seller: SellerSummaryResponse;
  /** True when the caller is the seller, so the UI can offer editing without a second call. */
  readonly isSeller: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ListingResponse = ListingSummaryResponse & {
  readonly description: string;
};

export type ListingListResponse = {
  readonly items: readonly ListingSummaryResponse[];
  readonly nextCursor: string | null;
};

export type OrderItemResponse = {
  readonly listingId: string;
  readonly title: string;
  readonly unitPriceMinor: number;
  readonly quantity: number;
  readonly lineTotalMinor: number;
};

export type OrderEventResponse = {
  readonly status: OrderStatus;
  readonly actor: 'BUYER' | 'SELLER' | 'PLATFORM';
  readonly at: string;
};

export type OrderResponse = {
  readonly id: string;
  readonly status: OrderStatus;
  readonly items: readonly OrderItemResponse[];
  readonly subtotalMinor: number;
  readonly shippingMinor: number;
  readonly commissionMinor: number;
  readonly totalMinor: number;
  readonly currency: MarketCurrency;
  readonly shippingAddress: string;
  readonly contactPhone: string | null;
  readonly buyer: SellerSummaryResponse;
  readonly seller: SellerSummaryResponse;
  readonly isBuyer: boolean;
  readonly isSeller: boolean;
  /** The actions *this* caller may take now, so the UI never offers a refused button. */
  readonly availableActions: readonly OrderAction[];
  readonly timeline: readonly OrderEventResponse[];
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type OrderListResponse = {
  readonly items: readonly OrderResponse[];
  readonly nextCursor: string | null;
};

export type CartPreviewResponse = {
  readonly lines: readonly OrderItemResponse[];
  readonly subtotalMinor: number;
  readonly shippingMinor: number;
  readonly totalMinor: number;
  readonly currency: MarketCurrency;
};

/** Everything the checkout page needs to explain a refusal in the buyer's own words. */
export const MARKET_FAILURES = {
  NOT_ENOUGH_STOCK: 'Someone else bought it while it was in your cart',
  LISTING_NOT_BUYABLE: 'That item is no longer for sale',
  EMPTY_CART: 'Your cart is empty',
  TOTAL_CHANGED: 'The price changed while you were checking out',
  CURRENCY_MISMATCH: 'Your cart mixes currencies',
  INVALID_TRANSITION: 'That is not something you can do to this order yet',
  NOT_YOUR_LISTING: 'That listing is not yours',
} as const;
