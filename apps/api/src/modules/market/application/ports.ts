/**
 * Market ports.
 *
 * Two stores, because listings and orders are read by different people for different
 * reasons and the transactional rules are not the same: a listing write is one row, while
 * a checkout is a stock hold, an order, its lines and its events inside one transaction.
 *
 * The one thing both stores share is `reserved`: the hold is a column on the *listing*, and
 * every read that decides "can this be bought" must see it. That is why `setReserved` is on
 * the listing store rather than folded into the order store — the counter belongs to the
 * thing being counted.
 */

export type SellerRecord = {
  readonly accountId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarKey: string | null;
};

export type ListingRecord = {
  readonly id: string;
  readonly sellerId: string;
  readonly seller: SellerRecord;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly stock: number;
  readonly reservedStock: number;
  readonly status: 'DRAFT' | 'ACTIVE' | 'SOLD_OUT' | 'WITHDRAWN';
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type ListingListQuery = {
  readonly viewerId: string;
  readonly limit: number;
  readonly cursor: string | null;
  readonly search: string | null;
  readonly sellerUsername: string | null;
  readonly mine: boolean;
};

export type ListingPage = {
  readonly items: readonly ListingRecord[];
};

export type ListingStore = {
  list(query: ListingListQuery): Promise<ListingPage>;
  find(viewerId: string, idOrSlug: string): Promise<ListingRecord | null>;
  /** An id-only read, without visibility: the checkout already knows which listings it wants. */
  findById(id: string): Promise<ListingRecord | null>;
  /**
   * True when that URL is already in use.
   *
   * A seller who does not choose a slug gets one derived from the title, and two sellers
   * naming their item "A good kettle" is normal. The check turns that into a readable `409`
   * — and the unique index is still the final answer if two requests race.
   */
  slugTaken(slug: string): Promise<boolean>;
  create(record: ListingRecord): Promise<ListingRecord | null>;
  update(
    sellerId: string,
    id: string,
    patch: {
      readonly title?: string;
      readonly description?: string;
      readonly priceMinor?: number;
      readonly stock?: number;
      readonly status?: ListingRecord['status'];
    },
  ): Promise<ListingRecord | null>;
  remove(sellerId: string, id: string): Promise<boolean>;
  /**
   * Adds to the reserve *only if the units are there*, in one statement.
   *
   * `UPDATE … SET reserved_stock = reserved_stock + $n WHERE id = … AND stock - reserved_stock >= $n`
   * returns zero rows when the stock is gone. Doing the check as a `SELECT` followed by an
   * `UPDATE` would leave a window in which two buyers both see the last unit.
   */
  reserve(id: string, quantity: number): Promise<boolean>;
  release(id: string, quantity: number): Promise<void>;
  /** Turns a hold into a sale: stock and reserve both fall by the quantity. */
  consume(id: string, quantity: number): Promise<void>;
  /**
   * Puts returned goods back on the shelf.
   *
   * A refund is not a cancellation: the units were sold and left the stock, so they have to
   * be added back rather than un-held. A listing that sold out on this order goes live again.
   */
  restock(id: string, quantity: number): Promise<void>;
};

export type OrderItemRecord = {
  readonly listingId: string;
  readonly title: string;
  readonly unitPriceMinor: number;
  readonly quantity: number;
};

export type OrderEventRecord = {
  readonly status: string;
  readonly actor: 'BUYER' | 'SELLER' | 'PLATFORM';
  readonly at: Date;
};

export type OrderRecord = {
  readonly id: string;
  readonly buyerId: string;
  readonly sellerId: string;
  readonly buyer: SellerRecord;
  readonly seller: SellerRecord;
  readonly status: string;
  readonly items: readonly OrderItemRecord[];
  readonly subtotalMinor: number;
  readonly shippingMinor: number;
  readonly commissionMinor: number;
  readonly totalMinor: number;
  readonly currency: string;
  readonly shippingAddress: string;
  readonly contactPhone: string | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly timeline: readonly OrderEventRecord[];
};

export type OrderListQuery = {
  readonly viewerId: string;
  readonly limit: number;
  readonly cursor: string | null;
  readonly role: 'BUYING' | 'SELLING';
  readonly status: string | null;
};

export type OrderPage = {
  readonly items: readonly OrderRecord[];
};

export type NewOrder = {
  readonly id: string;
  readonly buyerId: string;
  readonly sellerId: string;
  readonly status: string;
  readonly items: readonly OrderItemRecord[];
  readonly subtotalMinor: number;
  readonly shippingMinor: number;
  readonly commissionMinor: number;
  readonly totalMinor: number;
  readonly currency: string;
  readonly shippingAddress: string;
  readonly contactPhone: string | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
};

export type OrderStore = {
  list(query: OrderListQuery): Promise<OrderPage>;
  find(viewerId: string, id: string): Promise<OrderRecord | null>;
  /** One seller's orders, created together with their lines, events and stock holds. */
  create(order: NewOrder): Promise<OrderRecord>;
  setStatus(
    id: string,
    from: string,
    to: string,
    actor: 'BUYER' | 'SELLER' | 'PLATFORM',
    at: Date,
  ): Promise<OrderRecord | null>;
};
