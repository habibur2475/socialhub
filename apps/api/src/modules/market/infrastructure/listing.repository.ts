/**
 * Listing persistence.
 *
 * The one statement worth reading carefully is `reserve()`:
 *
 * ```sql
 * UPDATE market_listings
 *    SET reserved_stock = reserved_stock + $2
 *  WHERE id = $1 AND stock - reserved_stock >= $2 AND status = 'ACTIVE'
 * ```
 *
 * It is a *conditional* update, so the database decides whether the units are still there at
 * the instant of the write. A `SELECT`-then-`UPDATE` leaves a window in which two checkouts
 * both see the last unit and both succeed — the exact bug that ends a marketplace's
 * reputation, and it is invisible in testing until two people press buy together.
 *
 * Visibility: a draft listing is readable by its seller only, which is a `WHERE` clause here
 * rather than a check in the service, so a forgotten call cannot leak an unpublished price.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools, type Queryable } from '../../../database/pool.js';
import type {
  ListingListQuery,
  ListingPage,
  ListingRecord,
  ListingStore,
} from '../application/ports.js';

type RawListingRow = {
  id: string;
  seller_id: string;
  slug: string;
  title: string;
  description: string;
  price_minor: string;
  currency: string;
  stock: number;
  reserved_stock: number;
  status: ListingRecord['status'];
  created_at: Date;
  updated_at: Date;
  username: string;
  display_name: string;
  avatar_key: string | null;
};

const COLUMNS = `
  l.id, l.seller_id, l.slug, l.title, l.description, l.price_minor, l.currency,
  l.stock, l.reserved_stock, l.status, l.created_at, l.updated_at,
  p.username, p.display_name, p.avatar_key`;

const toRecord = (row: RawListingRow): ListingRecord => ({
  id: row.id,
  sellerId: row.seller_id,
  seller: {
    accountId: row.seller_id,
    username: row.username,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
  },
  slug: row.slug,
  title: row.title,
  description: row.description,
  // `bigint` arrives as a string from `pg`; converting here keeps every caller on `number`
  // and every amount exact up to 2^53 minor units, which the column ceiling guarantees.
  priceMinor: Number(row.price_minor),
  currency: row.currency,
  stock: row.stock,
  reservedStock: row.reserved_stock,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

@Injectable()
export class PostgresListingStore implements ListingStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  private db(): Queryable {
    return this.pools.pool();
  }

  public async list(query: ListingListQuery): Promise<ListingPage> {
    const params: unknown[] = [query.viewerId];
    const where = [`(l.status <> 'DRAFT' OR l.seller_id = $1)`];

    if (query.mine) where.push(`l.seller_id = $1`);

    if (query.sellerUsername !== null) {
      params.push(query.sellerUsername);
      where.push(`p.username = $${params.length}`);
    }

    if (query.search !== null && query.search.trim() !== '') {
      // A prefix match, so the index on `lower(title)` is usable. `LIKE '%…%'` would read
      // every listing on every keystroke of the search box.
      params.push(`${query.search.trim().toLowerCase()}%`);
      where.push(`lower(l.title) LIKE $${params.length}`);
    }

    if (query.cursor !== null) {
      const [createdAt = '', id = ''] = query.cursor.split('|');
      if (createdAt !== '' && id !== '') {
        params.push(createdAt, id);
        where.push(
          `(l.created_at, l.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
    }

    params.push(query.limit);

    const { rows } = await this.db().query<RawListingRow>(
      `SELECT ${COLUMNS}
         FROM market_listings l
         JOIN user_profiles p ON p.account_id = l.seller_id
        WHERE ${where.join(' AND ')}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT $${params.length}`,
      params,
    );

    return { items: rows.map(toRecord) };
  }

  public async find(viewerId: string, idOrSlug: string): Promise<ListingRecord | null> {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      idOrSlug,
    );

    const { rows } = await this.db().query<RawListingRow>(
      `SELECT ${COLUMNS}
         FROM market_listings l
         JOIN user_profiles p ON p.account_id = l.seller_id
        WHERE ${isUuid ? 'l.id = $2' : 'l.slug = $2'}
          AND (l.status <> 'DRAFT' OR l.seller_id = $1)`,
      [viewerId, idOrSlug],
    );

    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  public async findById(id: string): Promise<ListingRecord | null> {
    const { rows } = await this.db().query<RawListingRow>(
      `SELECT ${COLUMNS}
         FROM market_listings l
         JOIN user_profiles p ON p.account_id = l.seller_id
        WHERE l.id = $1`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  public async slugTaken(slug: string): Promise<boolean> {
    const { rowCount } = await this.db().query('SELECT 1 FROM market_listings WHERE slug = $1', [
      slug,
    ]);
    return rowCount !== null && rowCount > 0;
  }

  /**
   * Inserts a listing, answering `null` when the URL was taken between the check and here.
   *
   * The service checks first so it can say *why*; this guard is for the race the check cannot
   * close, and it keeps a `23505` from escaping as a `500`.
   */
  public async create(record: ListingRecord): Promise<ListingRecord | null> {
    let rows: RawListingRow[];
    try {
      ({ rows } = await this.db().query<RawListingRow>(
        `WITH inserted AS (
           INSERT INTO market_listings
             (id, seller_id, slug, title, description, price_minor, currency, stock, reserved_stock, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $10)
           RETURNING *
         )
         SELECT ${COLUMNS}
           FROM inserted l
           JOIN user_profiles p ON p.account_id = l.seller_id`,
        [
          record.id,
          record.sellerId,
          record.slug,
          record.title,
          record.description,
          record.priceMinor,
          record.currency,
          record.stock,
          record.status,
          record.createdAt,
        ],
      ));
    } catch (error) {
      // `23505` on a unique index. Only the slug can collide here — the id and the seller
      // are unique by construction — so the answer is "taken", not "server fault".
      if ((error as { code?: string }).code === '23505') return null;
      throw error;
    }

    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  public async update(
    sellerId: string,
    id: string,
    patch: {
      readonly title?: string;
      readonly description?: string;
      readonly priceMinor?: number;
      readonly stock?: number;
      readonly status?: ListingRecord['status'];
    },
  ): Promise<ListingRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [sellerId, id];

    const assign = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (patch.title !== undefined) assign('title', patch.title);
    if (patch.description !== undefined) assign('description', patch.description);
    if (patch.priceMinor !== undefined) assign('price_minor', patch.priceMinor);
    if (patch.stock !== undefined) assign('stock', patch.stock);
    if (patch.status !== undefined) assign('status', patch.status);

    if (sets.length === 0) return this.findById(id);

    const { rows } = await this.db().query<RawListingRow>(
      `WITH updated AS (
         UPDATE market_listings SET ${sets.join(', ')}
          WHERE id = $2 AND seller_id = $1
          RETURNING *
       )
       SELECT ${COLUMNS}
         FROM updated l
         JOIN user_profiles p ON p.account_id = l.seller_id`,
      params,
    );

    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  public async remove(sellerId: string, id: string): Promise<boolean> {
    // A listing with orders cannot be deleted: the receipt references it. `RESTRICT` in the
    // schema makes that a database answer, and the service maps it to a `409`.
    // The refusal is decided in the statement rather than caught from the foreign key: the
    // listing reference is `DEFERRABLE`, so a violation would surface at commit — after this
    // method had already answered. `NOT EXISTS` says the same thing at the row.
    const { rowCount } = await this.db().query(
      `DELETE FROM market_listings l
        WHERE l.id = $1
          AND l.seller_id = $2
          AND NOT EXISTS (SELECT 1 FROM market_order_items i WHERE i.listing_id = l.id)`,
      [id, sellerId],
    );
    return rowCount === 1;
  }

  public async reserve(id: string, quantity: number): Promise<boolean> {
    const { rowCount } = await this.db().query(
      `UPDATE market_listings
          SET reserved_stock = reserved_stock + $2
        WHERE id = $1
          AND status = 'ACTIVE'
          AND stock - reserved_stock >= $2`,
      [id, quantity],
    );
    return rowCount === 1;
  }

  public async release(id: string, quantity: number): Promise<void> {
    await this.db().query(
      `UPDATE market_listings
          SET reserved_stock = GREATEST(0, reserved_stock - $2)
        WHERE id = $1`,
      [id, quantity],
    );
  }

  public async consume(id: string, quantity: number): Promise<void> {
    await this.db().query(
      `UPDATE market_listings
          SET stock = GREATEST(0, stock - $2),
              reserved_stock = GREATEST(0, reserved_stock - $2),
              status = CASE WHEN stock - $2 <= 0 THEN 'SOLD_OUT' ELSE status END
        WHERE id = $1`,
      [id, quantity],
    );
  }

  public async restock(id: string, quantity: number): Promise<void> {
    await this.db().query(
      `UPDATE market_listings
          SET stock = stock + $2,
              status = CASE WHEN status = 'SOLD_OUT' THEN 'ACTIVE' ELSE status END
        WHERE id = $1 AND status <> 'WITHDRAWN'`,
      [id, quantity],
    );
  }
}
