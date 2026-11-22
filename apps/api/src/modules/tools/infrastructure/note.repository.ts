/**
 * Note persistence.
 *
 * Three details are load-bearing:
 *
 *   - **Ownership is in every `WHERE`, not checked afterwards.** A note that belongs to
 *     somebody else is `null`, so there is no code path where a missing check becomes a
 *     leak.
 *   - **Search folds case and accents in SQL** with `unaccent`-free `lower()` plus a
 *     `translate` for the common Latin range, so a search for `cafe` finds `café` without
 *     requiring an extension the deployment may not have.
 *   - **`total` is counted in the same query** with a window function: a notes list shows
 *     "12 notes" and a second round trip for the count would be a second chance to
 *     disagree with the rows.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools, type Queryable } from '../../../database/pool.js';
import type { NoteListQuery, NotePage, NoteRecord, NoteStore } from '../application/ports.js';

type RawNoteRow = {
  id: string;
  owner_id: string;
  title: string;
  body: string;
  pinned: boolean;
  created_at: Date;
  updated_at: Date;
  total: string;
};

const COLUMNS = 'n.id, n.owner_id, n.title, n.body, n.pinned, n.created_at, n.updated_at';

const toRecord = (row: RawNoteRow): NoteRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  title: row.title,
  body: row.body,
  pinned: row.pinned,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** Folds the Latin accents a Bangladeshi keyboard may or may not produce. */
const FOLDED = new Map([
  ['áàâäãå', 'a'],
  ['éèêë', 'e'],
  ['íìîï', 'i'],
  ['óòôöõ', 'o'],
  ['úùûü', 'u'],
  ['ñ', 'n'],
  ['ç', 'c'],
] as const);

const FOLD_FROM = [...FOLDED.keys()].join('');
const FOLD_TO = [...FOLDED.entries()]
  .map(([letters, plain]) => plain.repeat(letters.length))
  .join('');

@Injectable()
export class PostgresNoteRepository implements NoteStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  private db(): Queryable {
    return this.pools.pool();
  }

  public async list(query: NoteListQuery): Promise<NotePage> {
    const params: unknown[] = [query.ownerId];
    const where = ['n.owner_id = $1'];

    if (query.pinned !== undefined) {
      params.push(query.pinned);
      where.push(`n.pinned = $${params.length}`);
    }

    if (query.search !== null && query.search.trim() !== '') {
      params.push(query.search.trim().toLowerCase());
      // `translate` before `lower` so the fold is on the same characters on both sides.
      where.push(
        `translate(lower(n.title || ' ' || n.body), '${FOLD_FROM}', '${FOLD_TO}') LIKE '%' || translate($${params.length}, '${FOLD_FROM}', '${FOLD_TO}') || '%'`,
      );
    }

    if (query.cursor !== null) {
      // `<pinned>|<ISO>|<uuid>` — the same three columns the index is built on. A cursor
      // missing any of them pages through the pinned/unpinned boundary.
      const [flag = '', updatedAt = '', id = ''] = query.cursor.split('|');
      if ((flag === '0' || flag === '1') && updatedAt !== '' && id !== '') {
        params.push(flag === '1', updatedAt, id);
        where.push(
          `(n.pinned, n.updated_at, n.id) < ($${params.length - 2}::boolean, $${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
    }

    params.push(query.limit);

    const { rows } = await this.db().query<RawNoteRow>(
      `SELECT ${COLUMNS}, count(*) OVER () AS total
         FROM notes n
        WHERE ${where.join(' AND ')}
        ORDER BY n.pinned DESC, n.updated_at DESC, n.id DESC
        LIMIT $${params.length}`,
      params,
    );

    return { items: rows.map(toRecord), total: rows[0] === undefined ? 0 : Number(rows[0].total) };
  }

  public async find(ownerId: string, id: string): Promise<NoteRecord | null> {
    const { rows } = await this.db().query<RawNoteRow>(
      `SELECT ${COLUMNS}, 1 AS total FROM notes n WHERE n.owner_id = $1 AND n.id = $2`,
      [ownerId, id],
    );
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  public async create(record: NoteRecord): Promise<NoteRecord> {
    const { rows } = await this.db().query<RawNoteRow>(
      // The alias is what lets `RETURNING` use the same qualified column list as every
      // other statement in this file.
      `INSERT INTO notes AS n (id, owner_id, title, body, pinned, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING ${COLUMNS}, 1 AS total`,
      [record.id, record.ownerId, record.title, record.body, record.pinned, record.createdAt],
    );
    return toRecord(rows[0] as RawNoteRow);
  }

  public async update(
    ownerId: string,
    id: string,
    patch: { readonly title?: string; readonly body?: string; readonly pinned?: boolean },
  ): Promise<NoteRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [ownerId, id];

    if (patch.title !== undefined) {
      params.push(patch.title);
      sets.push(`title = $${params.length}`);
    }
    if (patch.body !== undefined) {
      params.push(patch.body);
      sets.push(`body = $${params.length}`);
    }
    if (patch.pinned !== undefined) {
      params.push(patch.pinned);
      sets.push(`pinned = $${params.length}`);
    }
    if (sets.length === 0) return this.find(ownerId, id);

    const { rows } = await this.db().query<RawNoteRow>(
      `UPDATE notes n SET ${sets.join(', ')}
        WHERE n.owner_id = $1 AND n.id = $2
        RETURNING ${COLUMNS}, 1 AS total`,
      params,
    );
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  public async remove(ownerId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db().query(
      `DELETE FROM notes WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    return rowCount === 1;
  }
}
