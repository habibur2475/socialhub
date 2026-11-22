/**
 * Order persistence.
 *
 * A checkout is the one operation in this module that must be atomic across four tables:
 * the orders row, its lines, the timeline's first event, and the hold on each listing. The
 * transaction is what makes "an order exists" and "the stock is held" the same fact — a
 * crash between them either loses a sale or oversells one.
 *
 * The lines' titles and prices are **copied, not joined**. A listing edited next week must
 * not rewrite what this buyer agreed to, and a withdrawn listing must not blank a receipt;
 * `market_order_items` is a snapshot by design.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools, type Queryable } from '../../../database/pool.js';
import type {
  NewOrder,
  OrderListQuery,
  OrderPage,
  OrderRecord,
  OrderStore,
  SellerRecord,
} from '../application/ports.js';

type RawOrderRow = {
  id: string;
  buyer_id: string;
  seller_id: string;
  status: string;
  subtotal_minor: string;
  shipping_minor: string;
  commission_minor: string;
  total_minor: string;
  currency: string;
  shipping_address: string;
  contact_phone: string | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  buyer_username: string;
  buyer_display_name: string;
  buyer_avatar_key: string | null;
  seller_username: string;
  seller_display_name: string;
  seller_avatar_key: string | null;
};

const COLUMNS = `
  o.id, o.buyer_id, o.seller_id, o.status, o.subtotal_minor, o.shipping_minor,
  o.commission_minor, o.total_minor, o.currency, o.shipping_address, o.contact_phone,
  o.expires_at, o.created_at, o.updated_at,
  buyer.username AS buyer_username, buyer.display_name AS buyer_display_name,
  buyer.avatar_key AS buyer_avatar_key,
  seller.username AS seller_username, seller.display_name AS seller_display_name,
  seller.avatar_key AS seller_avatar_key`;

const JOINS = `
  JOIN user_profiles buyer ON buyer.account_id = o.buyer_id
  JOIN user_profiles seller ON seller.account_id = o.seller_id`;

const party = (
  id: string,
  username: string,
  displayName: string,
  avatarKey: string | null,
): SellerRecord => ({ accountId: id, username, displayName, avatarKey });

@Injectable()
export class PostgresOrderStore implements OrderStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  private db(): Queryable {
    return this.pools.pool();
  }

  /** Lines and timeline for a set of orders, in two queries rather than 2×N. */
  private async hydrate(
    rows: readonly RawOrderRow[],
    db: Queryable = this.db(),
  ): Promise<OrderRecord[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);

    const [items, events] = await Promise.all([
      db.query<{
        order_id: string;
        listing_id: string;
        title_snapshot: string;
        unit_price_minor: string;
        quantity: number;
      }>(
        `SELECT order_id, listing_id, title_snapshot, unit_price_minor, quantity
           FROM market_order_items WHERE order_id = ANY($1::uuid[])`,
        [ids],
      ),
      db.query<{
        order_id: string;
        to_status: string;
        actor: 'BUYER' | 'SELLER' | 'PLATFORM';
        created_at: Date;
      }>(
        `SELECT order_id, to_status, actor, created_at
           FROM market_order_events WHERE order_id = ANY($1::uuid[])
          ORDER BY created_at, id`,
        [ids],
      ),
    ]);

    const itemsByOrder = new Map<string, OrderRecord['items'][number][]>();
    for (const item of items.rows) {
      const list = itemsByOrder.get(item.order_id) ?? [];
      list.push({
        listingId: item.listing_id,
        title: item.title_snapshot,
        unitPriceMinor: Number(item.unit_price_minor),
        quantity: item.quantity,
      });
      itemsByOrder.set(item.order_id, list);
    }

    const eventsByOrder = new Map<string, OrderRecord['timeline'][number][]>();
    for (const event of events.rows) {
      const list = eventsByOrder.get(event.order_id) ?? [];
      list.push({ status: event.to_status, actor: event.actor, at: event.created_at });
      eventsByOrder.set(event.order_id, list);
    }

    return rows.map((row) => ({
      id: row.id,
      buyerId: row.buyer_id,
      sellerId: row.seller_id,
      buyer: party(row.buyer_id, row.buyer_username, row.buyer_display_name, row.buyer_avatar_key),
      seller: party(
        row.seller_id,
        row.seller_username,
        row.seller_display_name,
        row.seller_avatar_key,
      ),
      status: row.status,
      items: itemsByOrder.get(row.id) ?? [],
      subtotalMinor: Number(row.subtotal_minor),
      shippingMinor: Number(row.shipping_minor),
      commissionMinor: Number(row.commission_minor),
      totalMinor: Number(row.total_minor),
      currency: row.currency,
      shippingAddress: row.shipping_address,
      contactPhone: row.contact_phone,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      timeline: eventsByOrder.get(row.id) ?? [],
    }));
  }

  public async list(query: OrderListQuery): Promise<OrderPage> {
    const params: unknown[] = [query.viewerId];
    const where = [query.role === 'SELLING' ? 'o.seller_id = $1' : 'o.buyer_id = $1'];

    if (query.status !== null) {
      params.push(query.status);
      where.push(`o.status = $${params.length}`);
    }

    if (query.cursor !== null) {
      const [createdAt = '', id = ''] = query.cursor.split('|');
      if (createdAt !== '' && id !== '') {
        params.push(createdAt, id);
        where.push(
          `(o.created_at, o.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
    }

    params.push(query.limit);

    const { rows } = await this.db().query<RawOrderRow>(
      `SELECT ${COLUMNS} FROM market_orders o ${JOINS}
        WHERE ${where.join(' AND ')}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $${params.length}`,
      params,
    );

    return { items: await this.hydrate(rows) };
  }

  public async find(viewerId: string, id: string): Promise<OrderRecord | null> {
    // Visibility is the pair of ids on the row; a stranger's order is `null` here, before
    // any service code sees it.
    const { rows } = await this.db().query<RawOrderRow>(
      `SELECT ${COLUMNS} FROM market_orders o ${JOINS}
        WHERE o.id = $2 AND (o.buyer_id = $1 OR o.seller_id = $1)`,
      [viewerId, id],
    );

    const hydrated = await this.hydrate(rows);
    return hydrated[0] ?? null;
  }

  public async create(order: NewOrder): Promise<OrderRecord> {
    return this.pools.transaction(async (client) => {
      await client.query(
        `INSERT INTO market_orders
           (id, buyer_id, seller_id, status, subtotal_minor, shipping_minor, commission_minor,
            total_minor, currency, shipping_address, contact_phone, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          order.id,
          order.buyerId,
          order.sellerId,
          order.status,
          order.subtotalMinor,
          order.shippingMinor,
          order.commissionMinor,
          order.totalMinor,
          order.currency,
          order.shippingAddress,
          order.contactPhone,
          order.expiresAt,
          order.createdAt,
        ],
      );

      for (const item of order.items) {
        await client.query(
          `INSERT INTO market_order_items
             (order_id, listing_id, title_snapshot, unit_price_minor, quantity)
           VALUES ($1, $2, $3, $4, $5)`,
          [order.id, item.listingId, item.title, item.unitPriceMinor, item.quantity],
        );
      }

      await client.query(
        `INSERT INTO market_order_events (id, order_id, from_status, to_status, actor, created_at)
         VALUES (gen_random_uuid(), $1, NULL, $2, 'BUYER', $3)`,
        [order.id, order.status, order.createdAt],
      );

      const { rows } = await client.query<RawOrderRow>(
        `SELECT ${COLUMNS} FROM market_orders o ${JOINS} WHERE o.id = $1`,
        [order.id],
      );

      const hydrated = await this.hydrate(rows, client);
      return hydrated[0] as OrderRecord;
    });
  }

  public async setStatus(
    id: string,
    from: string,
    to: string,
    actor: 'BUYER' | 'SELLER' | 'PLATFORM',
    at: Date,
  ): Promise<OrderRecord | null> {
    return this.pools.transaction(async (client) => {
      // The `AND status = $from` is optimistic concurrency: two people acting on the same
      // order at once — a refund racing a shipping update — must not both succeed, and the
      // loser gets a `null` rather than a silent overwrite.
      const updated = await client.query(
        `UPDATE market_orders SET status = $3, expires_at = NULL
          WHERE id = $1 AND status = $2`,
        [id, from, to],
      );

      if (updated.rowCount !== 1) return null;

      await client.query(
        `INSERT INTO market_order_events (id, order_id, from_status, to_status, actor, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [id, from, to, actor, at],
      );

      const { rows } = await client.query<RawOrderRow>(
        `SELECT ${COLUMNS} FROM market_orders o ${JOINS} WHERE o.id = $1`,
        [id],
      );

      const hydrated = await this.hydrate(rows, client);
      return hydrated[0] ?? null;
    });
  }
}
