/**
 * Market service rules.
 *
 * What the service decides rather than what the kernel already proves: who may see a draft,
 * that a cart is split by seller, that a failed reservation releases what it already held,
 * and that the actions offered on an order are the ones *this* caller may take.
 *
 * The database properties — the conditional reserve, the trigger that refuses an illegal
 * transition, the snapshot columns — live in the schema suite and the e2e suite.
 */

import { describe, expect, it, vi } from 'vitest';

import { MarketService, SHIPPING_MINOR } from './market.service.js';
import type { ListingRecord, ListingStore, OrderRecord, OrderStore } from './ports.js';

const SELLER = '0190f3c1-0000-7000-8000-00000000000a';
const SELLER2 = '0190f3c1-0000-7000-8000-00000000000b';
const BUYER = '0190f3c1-0000-7000-8000-00000000000c';
const NOW = new Date('2026-11-21T10:00:00.000Z');

const listing = (overrides: Partial<ListingRecord> = {}): ListingRecord => ({
  id: '0190f3c1-0000-7000-8000-0000000000d1',
  sellerId: SELLER,
  seller: { accountId: SELLER, username: 'ada', displayName: 'Ada', avatarKey: null },
  slug: 'a-good-kettle',
  title: 'A good kettle',
  description: '',
  priceMinor: 25_000,
  currency: 'BDT',
  stock: 5,
  reservedStock: 0,
  status: 'ACTIVE',
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const order = (overrides: Partial<OrderRecord> = {}): OrderRecord => ({
  id: '0190f3c1-0000-7000-8000-0000000000e1',
  buyerId: BUYER,
  sellerId: SELLER,
  buyer: { accountId: BUYER, username: 'grace', displayName: 'Grace', avatarKey: null },
  seller: { accountId: SELLER, username: 'ada', displayName: 'Ada', avatarKey: null },
  status: 'RESERVED',
  items: [
    {
      listingId: '0190f3c1-0000-7000-8000-0000000000d1',
      title: 'A good kettle',
      unitPriceMinor: 25_000,
      quantity: 2,
    },
  ],
  subtotalMinor: 50_000,
  shippingMinor: 6_000,
  commissionMinor: 5_000,
  totalMinor: 56_000,
  currency: 'BDT',
  shippingAddress: '12 Example Road, Khulna 9100',
  contactPhone: null,
  expiresAt: new Date(NOW.getTime() + 30 * 60_000),
  createdAt: NOW,
  updatedAt: NOW,
  timeline: [{ status: 'RESERVED', actor: 'BUYER', at: NOW }],
  ...overrides,
});

const createService = (
  options: {
    listings?: readonly ListingRecord[];
    reserves?: boolean;
    orders?: readonly OrderRecord[];
    order?: OrderRecord | null;
    setStatus?: OrderRecord | null;
  } = {},
) => {
  const catalogue = new Map(
    (options.listings ?? [listing()]).map((item) => [item.id, item] as const),
  );

  const listingStore = {
    list: vi.fn(async () => ({ items: [...catalogue.values()] })),
    find: vi.fn(async (_viewer: string, idOrSlug: string) => {
      const byId = catalogue.get(idOrSlug);
      if (byId !== undefined) return byId;
      return [...catalogue.values()].find((item) => item.slug === idOrSlug) ?? null;
    }),
    findById: vi.fn(async (id: string) => catalogue.get(id) ?? null),
    slugTaken: vi.fn(async () => false),
    create: vi.fn(async (record: ListingRecord) => record),
    update: vi.fn(async () => listing()),
    remove: vi.fn(async () => true),
    reserve: vi.fn(async () => options.reserves ?? true),
    release: vi.fn(async () => undefined),
    consume: vi.fn(async () => undefined),
    restock: vi.fn(async () => undefined),
  } satisfies ListingStore;

  const orderStore = {
    list: vi.fn(async () => ({ items: options.orders ?? [] })),
    find: vi.fn(async () => ('order' in options ? options.order : order())),
    create: vi.fn(async (input: Parameters<OrderStore['create']>[0]) =>
      order({ id: input.id, status: input.status, subtotalMinor: input.subtotalMinor }),
    ),
    setStatus: vi.fn(async () =>
      'setStatus' in options ? options.setStatus : order({ status: 'CANCELLED' }),
    ),
  } satisfies OrderStore;

  const service = new MarketService(
    listingStore,
    orderStore,
    { next: () => '0190f3c1-0000-7000-8000-0000000000f1' },
    () => NOW,
  );

  return { service, listingStore, orderStore };
};

const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  await expect(promise).rejects.toMatchObject({ error: { code } });
};

describe('listings', () => {
  it('reports what a buyer may add to a cart, not the raw stock', async () => {
    const { service } = createService({ listings: [listing({ stock: 5, reservedStock: 2 })] });
    const summary = await service.listing(BUYER, 'a-good-kettle');
    expect(summary).toMatchObject({ stock: 5, available: 3, isSeller: false });
  });

  it('marks the seller’s own listing so the UI can offer editing', async () => {
    const { service } = createService();
    expect((await service.listing(SELLER, 'a-good-kettle')).isSeller).toBe(true);
  });

  it('derives a slug from the title, with the id as the fallback token', async () => {
    const { service, listingStore } = createService();
    await service.createListing(SELLER, {
      title: 'A Good Kettle',
      price: 25_000,
      currency: 'BDT',
      stock: 3,
      status: 'ACTIVE',
    });

    expect(listingStore.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'a-good-kettle', status: 'ACTIVE', reservedStock: 0 }),
    );
  });

  /** Two sellers naming their item the same thing is normal; the URL is what has to decide. */
  it('refuses a slug that is already in use with a 409', async () => {
    const { service, listingStore } = createService();
    listingStore.slugTaken.mockResolvedValueOnce(true);

    await expectCode(
      service.createListing(SELLER, {
        title: 'A Good Kettle',
        price: 25_000,
        currency: 'BDT',
        stock: 1,
        status: 'ACTIVE',
      }),
      'CONFLICT',
    );
    expect(listingStore.create).not.toHaveBeenCalled();
  });

  it('refuses an active listing with nothing to sell', async () => {
    const { service } = createService();
    await expectCode(
      service.createListing(SELLER, {
        title: 'A Good Kettle',
        price: 25_000,
        currency: 'BDT',
        stock: 0,
        status: 'ACTIVE',
      }),
      'VALIDATION_FAILED',
    );
  });

  /** Another seller's draft is not disclosed, and neither is the fact that it exists. */
  it('answers 404 when somebody else edits your listing', async () => {
    const { service } = createService();
    await expectCode(
      service.updateListing(SELLER2, '0190f3c1-0000-7000-8000-0000000000d1', {
        title: 'Mine now',
      }),
      'NOT_FOUND',
    );
  });

  it('refuses to resurrect a withdrawn listing', async () => {
    const { service } = createService({ listings: [listing({ status: 'WITHDRAWN' })] });
    await expectCode(
      service.updateListing(SELLER, '0190f3c1-0000-7000-8000-0000000000d1', { status: 'ACTIVE' }),
      'PRECONDITION_FAILED',
    );
  });

  it('refuses to take a live listing below one unit of stock', async () => {
    const { service } = createService();
    await expectCode(
      service.updateListing(SELLER, '0190f3c1-0000-7000-8000-0000000000d1', { stock: 0 }),
      'VALIDATION_FAILED',
    );
  });
});

describe('checkout', () => {
  const input = (overrides: Partial<Parameters<MarketService['checkout']>[1]> = {}) => ({
    lines: [{ listingId: '0190f3c1-0000-7000-8000-0000000000d1', quantity: 2 }],
    shippingAddress: '12 Example Road, Khulna 9100',
    quotedTotalMinor: 50_000 + SHIPPING_MINOR,
    ...overrides,
  });

  it('creates one order with the kernel’s pricing', async () => {
    const { service, orderStore } = createService();
    const orders = await service.checkout(BUYER, input());

    expect(orders).toHaveLength(1);
    expect(orderStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        buyerId: BUYER,
        sellerId: SELLER,
        status: 'RESERVED',
        subtotalMinor: 50_000,
        shippingMinor: SHIPPING_MINOR,
        commissionMinor: 5_000,
        totalMinor: 56_000,
        items: [
          expect.objectContaining({ quantity: 2, unitPriceMinor: 25_000, title: 'A good kettle' }),
        ],
      }),
    );
  });

  /** A cart with two sellers is two orders: one shipment, one payout, one refund each. */
  it('splits a cart by seller', async () => {
    const second = listing({
      id: '0190f3c1-0000-7000-8000-0000000000d2',
      sellerId: SELLER2,
      slug: 'a-second-kettle',
      priceMinor: 10_000,
    });
    const { service, orderStore } = createService({ listings: [listing(), second] });

    const orders = await service.checkout(
      BUYER,
      input({
        lines: [
          { listingId: '0190f3c1-0000-7000-8000-0000000000d1', quantity: 1 },
          { listingId: '0190f3c1-0000-7000-8000-0000000000d2', quantity: 2 },
        ],
        quotedTotalMinor: 25_000 + 20_000 + SHIPPING_MINOR * 2,
      }),
    );

    expect(orders).toHaveLength(2);
    expect(orderStore.create).toHaveBeenCalledTimes(2);
    const sellers = orderStore.create.mock.calls.map(([created]) => created.sellerId);
    expect(sellers.sort()).toEqual([SELLER, SELLER2].sort());
  });

  /** The quoted total is the buyer's proof of what they agreed to; a change is a `409`. */
  it('refuses a total that changed since the page was rendered', async () => {
    const { service, orderStore } = createService();
    await expectCode(service.checkout(BUYER, input({ quotedTotalMinor: 30_000 })), 'CONFLICT');
    expect(orderStore.create).not.toHaveBeenCalled();
  });

  it('refuses a cart with more than the available stock', async () => {
    const { service } = createService({ listings: [listing({ stock: 1 })] });
    await expectCode(service.checkout(BUYER, input()), 'CONFLICT');
  });

  it('refuses buying your own listing', async () => {
    const { service } = createService();
    await expectCode(service.checkout(SELLER, input()), 'VALIDATION_FAILED');
  });

  /**
   * The important failure: if the second reservation fails, the first must be released. A
   * checkout that leaves a hold behind keeps another buyer's stock for half an hour.
   */
  it('releases a hold it had already made when a later reservation fails', async () => {
    const second = listing({ id: '0190f3c1-0000-7000-8000-0000000000d2', sellerId: SELLER2 });
    const { service, listingStore } = createService({ listings: [listing(), second] });
    listingStore.reserve.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expectCode(
      service.checkout(
        BUYER,
        input({
          lines: [
            { listingId: '0190f3c1-0000-7000-8000-0000000000d1', quantity: 1 },
            { listingId: '0190f3c1-0000-7000-8000-0000000000d2', quantity: 1 },
          ],
          quotedTotalMinor: 25_000 + 25_000 + SHIPPING_MINOR * 2,
        }),
      ),
      'CONFLICT',
    );

    expect(listingStore.release).toHaveBeenCalledWith('0190f3c1-0000-7000-8000-0000000000d1', 1);
  });
});

describe('orders', () => {
  it('offers the buyer exactly the actions the state machine permits them', async () => {
    const { service } = createService({ order: order({ status: 'RESERVED' }) });
    const viewed = await service.order(BUYER, '0190f3c1-0000-7000-8000-0000000000e1');
    expect(viewed.availableActions).toEqual(['CANCEL']);
    expect(viewed.isBuyer).toBe(true);
  });

  it('offers the seller shipping once the order is paid', async () => {
    const { service } = createService({ order: order({ status: 'PAID' }) });
    const viewed = await service.order(SELLER, '0190f3c1-0000-7000-8000-0000000000e1');
    expect(viewed.availableActions).toEqual(['SHIP', 'REFUND']);
  });

  it('never offers a refund to the buyer', async () => {
    const { service } = createService({ order: order({ status: 'PAID' }) });
    const viewed = await service.order(BUYER, '0190f3c1-0000-7000-8000-0000000000e1');
    expect(viewed.availableActions).toEqual([]);
  });

  it('releases the hold when the buyer cancels', async () => {
    const { service, listingStore } = createService();
    await service.actOnOrder(BUYER, '0190f3c1-0000-7000-8000-0000000000e1', { action: 'CANCEL' });
    expect(listingStore.release).toHaveBeenCalledWith('0190f3c1-0000-7000-8000-0000000000d1', 2);
  });

  it('refuses a cancellation of a paid order with a precondition failure', async () => {
    const { service } = createService({ order: order({ status: 'PAID' }) });
    await expectCode(
      service.actOnOrder(BUYER, '0190f3c1-0000-7000-8000-0000000000e1', { action: 'CANCEL' }),
      'PRECONDITION_FAILED',
    );
  });

  it('refuses shipping an order that was never paid', async () => {
    const { service } = createService({ order: order({ status: 'PENDING' }) });
    await expectCode(
      service.actOnOrder(SELLER, '0190f3c1-0000-7000-8000-0000000000e1', { action: 'SHIP' }),
      'PRECONDITION_FAILED',
    );
  });

  /** Two people acting at once must not both win; the loser is a `409`, not a silent success. */
  it('answers 409 when the order moved while the request was in flight', async () => {
    const { service } = createService({ setStatus: null });
    await expectCode(
      service.actOnOrder(BUYER, '0190f3c1-0000-7000-8000-0000000000e1', { action: 'CANCEL' }),
      'CONFLICT',
    );
  });

  it('answers 404 for an order that is neither yours to buy nor yours to sell', async () => {
    const { service } = createService({ order: null });
    await expectCode(service.order(BUYER, '0190f3c1-0000-7000-8000-0000000000e1'), 'NOT_FOUND');
  });

  /** A refund is not a cancellation: the units were sold, so they must be added back. */
  it('puts the goods back on the shelf when the seller refunds', async () => {
    const { service, listingStore } = createService({ order: order({ status: 'PAID' }) });
    await service.actOnOrder(SELLER, '0190f3c1-0000-7000-8000-0000000000e1', { action: 'REFUND' });
    expect(listingStore.restock).toHaveBeenCalledWith('0190f3c1-0000-7000-8000-0000000000d1', 2);
    expect(listingStore.release).not.toHaveBeenCalled();
  });

  it('previews a refund as goods plus commission, and never the postage', async () => {
    const { service } = createService();
    expect(service.refundPreview(order())).toEqual({ refunded: 50_000, commissionReturned: 5_000 });
  });
});
