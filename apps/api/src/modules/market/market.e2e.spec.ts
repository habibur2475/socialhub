/**
 * Market end-to-end tests.
 *
 * The properties that need a database and a real HTTP stack: the reserve is a conditional
 * `UPDATE`, so two buyers racing for the last unit cannot both win; the transition trigger
 * refuses an illegal move even if the service were wrong; the order total is the sum of its
 * parts by constraint, not by convention; and the cart splits by seller over the wire.
 */

import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { RequestMethod, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module.js';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter.js';
import { MemoryCache } from '../../common/cache/memory-cache.js';
import { CACHE } from '../../database/cache.provider.js';
import { JsonLogger } from '../../common/logging/logger.js';

const CONNECTION = process.env['TEST_DATABASE_URL'];
const describeWithDb = CONNECTION === undefined ? describe.skip : describe;

const PASSWORD = 'correct-horse-battery';
const ADDRESS = '12 Example Road, Khulna 9100';

type Actor = { accountId: string; username: string; accessToken: string };

type Listing = {
  id: string;
  slug: string;
  title: string;
  priceMinor: number;
  stock: number;
  available: number;
  status: string;
  isSeller: boolean;
};

type Order = {
  id: string;
  status: string;
  subtotalMinor: number;
  shippingMinor: number;
  commissionMinor: number;
  totalMinor: number;
  availableActions: string[];
  items: { listingId: string; title: string; quantity: number; lineTotalMinor: number }[];
};

describeWithDb('market (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = CONNECTION;
    process.env['NODE_ENV'] = 'test';
    process.env['CACHE_DRIVER'] = 'memory';
    process.env['REDIS_URL'] = 'redis://127.0.0.1:6379';
    process.env['JWT_ACCESS_SECRET'] = 'test-access-secret-with-at-least-32-characters';
    process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-with-at-least-32-chars-x';
    process.env['LOG_LEVEL'] = 'fatal';
    process.env['OTP_TTL_SECONDS'] = '600';

    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CACHE)
      .useFactory({ factory: () => new MemoryCache(), inject: [] })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: new JsonLogger('fatal'),
    });
    app.useGlobalFilters(new AllExceptionsFilter(new JsonLogger('fatal')));
    app.use(cookieParser());
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'health/live', method: RequestMethod.GET },
        { path: 'health/ready', method: RequestMethod.GET },
      ],
    });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();

    pool = new Pool({ connectionString: CONNECTION, max: 4 });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM market_order_events');
    await pool.query('DELETE FROM market_order_items');
    await pool.query('DELETE FROM market_orders');
    await pool.query('DELETE FROM market_listings');
    await pool.query('DELETE FROM messages');
    await pool.query('DELETE FROM message_participants');
    await pool.query('DELETE FROM message_threads');
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM notes');
    await pool.query('DELETE FROM blocks');
    await pool.query('DELETE FROM follows');
    await pool.query('DELETE FROM verification_codes');
    await pool.query('DELETE FROM refresh_tokens');
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM user_roles');
    await pool.query('DELETE FROM user_profiles');
    await pool.query(`DELETE FROM accounts WHERE account_type = 'USER'`);
  });

  const createActor = async (): Promise<Actor> => {
    const email = `m-${randomUUID()}@example.test`;
    const username = `u_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: PASSWORD, username, displayName: 'Market Tester' })
      .expect(202);

    const { rows } = await pool.query<{ code_digest: Buffer; id: string }>(
      `SELECT vc.code_digest, a.id FROM verification_codes vc
         JOIN accounts a ON a.id = vc.account_id
        WHERE a.email = $1 AND vc.purpose = 'EMAIL_VERIFY'`,
      [email],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('verification code missing');

    const { digestOtp } = await import('../auth/domain/one-time-code.js');
    let code = '';
    for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
      const attempt = candidate.toString().padStart(6, '0');
      if (
        digestOtp({ accountId: row.id, purpose: 'EMAIL_VERIFY', code: attempt }).equals(
          row.code_digest,
        )
      ) {
        code = attempt;
        break;
      }
    }
    if (code === '') throw new Error('could not recover OTP');

    await request(app.getHttpServer())
      .post('/api/v1/auth/verify-email')
      .send({ email, code })
      .expect(200);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);

    return { accountId: row.id, username, accessToken: login.body.accessToken as string };
  };

  const auth = (actor: Actor) => ({ authorization: `Bearer ${actor.accessToken}` });

  const createListing = async (
    actor: Actor,
    input: Partial<{ title: string; price: string; stock: number; status: string }> = {},
  ): Promise<Listing> => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/market/listings')
      .set(auth(actor))
      .send({
        title: input.title ?? `Kettle ${randomUUID().slice(0, 8)}`,
        description: 'A kettle that boils water.',
        price: input.price ?? '250',
        stock: input.stock ?? 5,
        status: input.status ?? 'ACTIVE',
      })
      .expect(201);

    return response.body as Listing;
  };

  const checkout = (
    actor: Actor,
    lines: { listingId: string; quantity: number }[],
    quotedTotalMinor: number,
  ) =>
    request(app.getHttpServer())
      .post('/api/v1/market/orders')
      .set(auth(actor))
      .send({ lines, shippingAddress: ADDRESS, quotedTotalMinor });

  const act = (actor: Actor, orderId: string, action: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/market/orders/${orderId}/actions`)
      .set(auth(actor))
      .send({ action });

  /** Total for a cart, computed the way the buyer's page would: goods plus one postage each. */
  const quoted = (
    lines: { listing: { priceMinor: number }; quantity: number }[],
    sellers = 1,
  ): number =>
    lines.reduce((total, line) => total + line.listing.priceMinor * line.quantity, 0) +
    6_000 * sellers;

  describe('listings', () => {
    it('returns the price as integer minor units and the available count', async () => {
      const seller = await createActor();
      const listing = await createListing(seller, { price: '250.50', stock: 3 });

      expect(listing).toMatchObject({
        priceMinor: 25_050,
        stock: 3,
        available: 3,
        status: 'ACTIVE',
        isSeller: true,
      });
      expect(listing.slug).toMatch(/^kettle-[a-z0-9-]+$/u);
    });

    /**
     * Two sellers with the same product name is the normal case, not an error. The derived
     * URL is what collides, so the second one is told, not silently renamed.
     */
    it('answers 409 when two sellers derive the same slug', async () => {
      const first = await createActor();
      const second = await createActor();

      await createListing(first, { title: 'Identical Kettle' });
      await request(app.getHttpServer())
        .post('/api/v1/market/listings')
        .set(auth(second))
        .send({ title: 'Identical Kettle', price: '250', stock: 1, status: 'ACTIVE' })
        .expect(409);
    });

    it('refuses a third decimal place and a rounded-down price', async () => {
      const seller = await createActor();

      await request(app.getHttpServer())
        .post('/api/v1/market/listings')
        .set(auth(seller))
        .send({ title: 'Too precise', price: '1.234', stock: 1 })
        .expect(422);

      await request(app.getHttpServer())
        .post('/api/v1/market/listings')
        .set(auth(seller))
        .send({ title: 'Too cheap', price: '0.50', stock: 1 })
        .expect(422);
    });

    it('hides a draft from everybody but its seller', async () => {
      const seller = await createActor();
      const stranger = await createActor();
      const draft = await createListing(seller, { status: 'DRAFT', stock: 0 });

      await request(app.getHttpServer())
        .get(`/api/v1/market/listings/${draft.id}`)
        .set(auth(stranger))
        .expect(404);

      const mine = await request(app.getHttpServer())
        .get(`/api/v1/market/listings/${draft.id}`)
        .set(auth(seller))
        .expect(200);
      expect(mine.body.status).toBe('DRAFT');
    });

    it('lists one page at a time with a cursor that neither skips nor repeats', async () => {
      const seller = await createActor();
      for (let index = 0; index < 5; index += 1) {
        await createListing(seller, { title: `Paged item ${index}` });
      }

      const first = await request(app.getHttpServer())
        .get('/api/v1/market/listings?limit=2')
        .set(auth(seller))
        .expect(200);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await request(app.getHttpServer())
          .get(
            `/api/v1/market/listings?limit=2${
              cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
            }`,
          )
          .set(auth(seller))
          .expect(200);
        for (const item of page.body.items as Listing[]) {
          expect(seen.has(item.id)).toBe(false);
          seen.add(item.id);
        }
        cursor = page.body.nextCursor as string | null;
      } while (cursor !== null);

      expect(seen.size).toBe(5);
    });

    it('refuses to delete a listing that has orders, and withdraws it instead', async () => {
      const seller = await createActor();
      const buyer = await createActor();
      const listing = await createListing(seller, { stock: 2 });

      await checkout(
        buyer,
        [{ listingId: listing.id, quantity: 1 }],
        quoted([{ listing, quantity: 1 }]),
      ).expect(201);

      await request(app.getHttpServer())
        .delete(`/api/v1/market/listings/${listing.id}`)
        .set(auth(seller))
        .expect(409);

      const withdrawn = await request(app.getHttpServer())
        .patch(`/api/v1/market/listings/${listing.id}`)
        .set(auth(seller))
        .send({ status: 'WITHDRAWN' })
        .expect(200);
      expect(withdrawn.body.status).toBe('WITHDRAWN');
    });

    it('answers 404 when another seller edits or deletes your listing', async () => {
      const seller = await createActor();
      const stranger = await createActor();
      const listing = await createListing(seller);

      await request(app.getHttpServer())
        .patch(`/api/v1/market/listings/${listing.id}`)
        .set(auth(stranger))
        .send({ price: '1' })
        .expect(404);

      await request(app.getHttpServer())
        .delete(`/api/v1/market/listings/${listing.id}`)
        .set(auth(stranger))
        .expect(404);
    });
  });

  describe('checkout', () => {
    it('creates one reserved order that holds the stock', async () => {
      const seller = await createActor();
      const buyer = await createActor();
      const listing = await createListing(seller, { price: '250', stock: 5 });

      const response = await checkout(
        buyer,
        [{ listingId: listing.id, quantity: 2 }],
        quoted([{ listing, quantity: 2 }], 1),
      ).expect(201);

      expect(response.body).toHaveLength(1);
      const order = response.body[0] as Order;
      expect(order).toMatchObject({
        status: 'RESERVED',
        subtotalMinor: 50_000,
        shippingMinor: 6_000,
        commissionMinor: 5_000,
        totalMinor: 56_000,
        availableActions: ['CANCEL'],
      });
      expect(order.items[0]).toMatchObject({
        title: listing.title,
        unitPriceMinor: 25_000,
        lineTotalMinor: 50_000,
      });

      const after = await request(app.getHttpServer())
        .get(`/api/v1/market/listings/${listing.id}`)
        .set(auth(buyer))
        .expect(200);
      expect(after.body).toMatchObject({ stock: 5, available: 3 });
    });

    it('splits a two-seller cart into two orders with one postage each', async () => {
      const sellerA = await createActor();
      const sellerB = await createActor();
      const buyer = await createActor();
      const first = await createListing(sellerA, { price: '100' });
      const second = await createListing(sellerB, { price: '40' });

      const response = await checkout(
        buyer,
        [
          { listingId: first.id, quantity: 1 },
          { listingId: second.id, quantity: 1 },
        ],
        quoted(
          [
            { listing: first, quantity: 1 },
            { listing: second, quantity: 1 },
          ],
          2,
        ),
      ).expect(201);

      expect(response.body).toHaveLength(2);
      const totals = (response.body as Order[]).map((order) => order.totalMinor).sort();
      // `100.00` and `40.00` in minor units, plus one `60.00` postage per seller.
      expect(totals).toEqual([10_000 + 6_000, 4_000 + 6_000].sort());
    });

    it('refuses a total that no longer matches the cart', async () => {
      const seller = await createActor();
      const buyer = await createActor();
      const listing = await createListing(seller, { price: '250' });

      await checkout(buyer, [{ listingId: listing.id, quantity: 1 }], 1_000).expect(409);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/market/listings/${listing.id}`)
        .set(auth(buyer))
        .expect(200);
      // A refused checkout holds nothing.
      expect(after.body.available).toBe(listing.stock);
    });

    it('refuses buying your own listing and buying more than is available', async () => {
      const seller = await createActor();
      const listing = await createListing(seller, { stock: 1 });

      await checkout(
        seller,
        [{ listingId: listing.id, quantity: 1 }],
        quoted([{ listing, quantity: 1 }]),
      ).expect(422);

      const buyer = await createActor();
      await checkout(
        buyer,
        [{ listingId: listing.id, quantity: 2 }],
        quoted([{ listing, quantity: 2 }], 1),
      ).expect(409);
    });

    /**
     * Two buyers, one unit. The conditional `UPDATE … WHERE stock - reserved_stock >= n`
     * is what makes exactly one of them win; without it both would read stock 1 first.
     */
    it('lets exactly one of two racing buyers take the last unit', async () => {
      const seller = await createActor();
      const first = await createActor();
      const second = await createActor();
      const listing = await createListing(seller, { stock: 1 });

      const results = await Promise.all([
        checkout(
          first,
          [{ listingId: listing.id, quantity: 1 }],
          quoted([{ listing, quantity: 1 }]),
        ),
        checkout(
          second,
          [{ listingId: listing.id, quantity: 1 }],
          quoted([{ listing, quantity: 1 }]),
        ),
      ]);

      const codes = results.map((result) => result.status).sort();
      expect(codes).toEqual([201, 409]);

      const { rows } = await pool.query<{ reserved_stock: number }>(
        'SELECT reserved_stock FROM market_listings WHERE id = $1',
        [listing.id],
      );
      expect(rows[0]?.reserved_stock).toBe(1);
    });
  });

  describe('orders and their moves', () => {
    const paidOrder = async (): Promise<{
      seller: Actor;
      buyer: Actor;
      order: Order;
      listing: Listing;
    }> => {
      const seller = await createActor();
      const buyer = await createActor();
      const listing = await createListing(seller, { price: '250', stock: 3 });
      const response = await checkout(
        buyer,
        [{ listingId: listing.id, quantity: 1 }],
        quoted([{ listing, quantity: 1 }]),
      ).expect(201);
      const order = response.body[0] as Order;

      // `RESERVED → PAID` is the platform's move; the demo has no payment provider, so the
      // test stands in for the webhook with the same statement the provider will run.
      // The expiry is only allowed while an order holds stock, so paying clears it.
      await pool.query(
        "UPDATE market_orders SET status = 'PAID', expires_at = NULL WHERE id = $1",
        [order.id],
      );
      await pool.query(
        `INSERT INTO market_order_events (id, order_id, from_status, to_status, actor)
         VALUES (gen_random_uuid(), $1, 'RESERVED', 'PAID', 'PLATFORM')`,
        [order.id],
      );
      // Paying turns the hold into a sale, which is what the platform's callback does: the
      // reserve drains and the stock leaves the shelf.
      for (const item of order.items) {
        await pool.query(
          `UPDATE market_listings
              SET stock = stock - $2, reserved_stock = reserved_stock - $2
            WHERE id = $1`,
          [item.listingId, item.quantity],
        );
      }

      return { seller, buyer, order, listing };
    };

    it('releases the hold when the buyer cancels an unpaid order', async () => {
      const seller = await createActor();
      const buyer = await createActor();
      const listing = await createListing(seller, { stock: 2 });
      const response = await checkout(
        buyer,
        [{ listingId: listing.id, quantity: 2 }],
        quoted([{ listing, quantity: 2 }]),
      ).expect(201);
      const order = response.body[0] as Order;

      const cancelled = await act(buyer, order.id, 'CANCEL').expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');

      const after = await request(app.getHttpServer())
        .get(`/api/v1/market/listings/${listing.id}`)
        .set(auth(buyer))
        .expect(200);
      expect(after.body.available).toBe(2);
    });

    it('offers the seller shipping once paid, and the buyer nothing', async () => {
      const { seller, buyer, order } = await paidOrder();

      const asSeller = await request(app.getHttpServer())
        .get(`/api/v1/market/orders/${order.id}`)
        .set(auth(seller))
        .expect(200);
      expect(asSeller.body.availableActions).toEqual(['SHIP', 'REFUND']);

      const asBuyer = await request(app.getHttpServer())
        .get(`/api/v1/market/orders/${order.id}`)
        .set(auth(buyer))
        .expect(200);
      expect(asBuyer.body.availableActions).toEqual([]);
    });

    it('walks PAID → SHIPPED → DELIVERED and appends the timeline', async () => {
      const { seller, buyer, order } = await paidOrder();

      await act(seller, order.id, 'SHIP').expect(200);
      const delivered = await act(seller, order.id, 'DELIVER').expect(200);

      expect(delivered.body.status).toBe('DELIVERED');
      const statuses = (delivered.body.timeline as { status: string }[]).map((e) => e.status);
      expect(statuses).toEqual(['RESERVED', 'PAID', 'SHIPPED', 'DELIVERED']);

      const asBuyer = await request(app.getHttpServer())
        .get(`/api/v1/market/orders/${order.id}`)
        .set(auth(buyer))
        .expect(200);
      expect(asBuyer.body.status).toBe('DELIVERED');
    });

    it('refuses a move the state machine does not allow with a 412', async () => {
      const { seller, buyer, order } = await paidOrder();

      // Shipping twice, and a buyer trying to ship at all.
      await act(seller, order.id, 'SHIP').expect(200);
      await act(seller, order.id, 'SHIP').expect(412);
      await act(buyer, order.id, 'DELIVER').expect(412);
    });

    /** The trigger is the last line of defence: even a direct write cannot lie its way in. */
    it('refuses an illegal transition written straight to the table', async () => {
      const { order } = await paidOrder();

      await expect(
        pool.query('UPDATE market_orders SET status = $2 WHERE id = $1', [order.id, 'RESERVED']),
      ).rejects.toThrow(/illegal order transition/u);
    });

    it('keeps the total equal to the sum of its parts by constraint', async () => {
      const { order } = await paidOrder();

      await expect(
        pool.query('UPDATE market_orders SET total_minor = total_minor + 1 WHERE id = $1', [
          order.id,
        ]),
      ).rejects.toThrow(/total_is_sum/u);
    });

    it('lists buying and selling separately', async () => {
      const { seller, buyer, order } = await paidOrder();

      const buying = await request(app.getHttpServer())
        .get('/api/v1/market/orders?role=BUYING')
        .set(auth(buyer))
        .expect(200);
      expect(buying.body.items).toHaveLength(1);

      const selling = await request(app.getHttpServer())
        .get('/api/v1/market/orders?role=SELLING')
        .set(auth(seller))
        .expect(200);
      expect(selling.body.items).toHaveLength(1);
      expect(selling.body.items[0].id).toBe(order.id);

      const wrongSide = await request(app.getHttpServer())
        .get('/api/v1/market/orders?role=BUYING')
        .set(auth(seller))
        .expect(200);
      expect(wrongSide.body.items).toHaveLength(0);
    });

    it('answers 404 for somebody else’s order', async () => {
      const { order } = await paidOrder();
      const stranger = await createActor();

      await request(app.getHttpServer())
        .get(`/api/v1/market/orders/${order.id}`)
        .set(auth(stranger))
        .expect(404);
    });

    it('puts the goods back on the shelf when the seller refunds', async () => {
      const { seller, order, listing } = await paidOrder();

      const { rows: sold } = await pool.query<{ stock: number; reserved_stock: number }>(
        'SELECT stock, reserved_stock FROM market_listings WHERE id = $1',
        [listing.id],
      );
      expect(sold[0]).toMatchObject({ stock: listing.stock - 1, reserved_stock: 0 });

      const refunded = await act(seller, order.id, 'REFUND').expect(200);
      expect(refunded.body.status).toBe('REFUNDED');

      // A refund is not a cancellation: the unit left the shelf when it was sold, so it has
      // to come back rather than merely stop being held.
      const { rows: after } = await pool.query<{ stock: number; reserved_stock: number }>(
        'SELECT stock, reserved_stock FROM market_listings WHERE id = $1',
        [listing.id],
      );
      expect(after[0]).toMatchObject({ stock: listing.stock, reserved_stock: 0 });
    });

    it('refuses a refund asked for by the buyer', async () => {
      const { buyer, order } = await paidOrder();
      await act(buyer, order.id, 'REFUND').expect(412);
    });
  });
});
