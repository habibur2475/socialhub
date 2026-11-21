/**
 * Notification persistence.
 *
 * Collapsing is done by the database, in one statement:
 *
 *   INSERT … ON CONFLICT (recipient_id, group_key) DO UPDATE
 *
 * That is the whole reason the unique index exists. Doing it in two steps — read,
 * then insert or update — lets two concurrent likes on the same post both miss and
 * both insert, which is precisely the burst the collapse is meant to absorb.
 *
 * The `recent_actor_ids` array is bounded by the table's CHECK constraint and
 * deduplicated here: the same actor liking, unliking and liking again is still one
 * person, and `actor_count` must not inflate.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools } from '../../../database/pool.js';
import type {
  NotificationActorRecord,
  NotificationPage,
  NotificationQuery,
  NotificationRecord,
  NotificationStore,
  NotificationWrite,
} from '../application/ports.js';
import type { NotificationKind, NotificationSubjectType } from '@socialhub/kernel';

type RawRow = {
  id: string;
  recipient_id: string;
  kind: NotificationKind;
  actor_count: number;
  recent_actor_ids: string[];
  subject_type: NotificationSubjectType | null;
  subject_id: string | null;
  preview: string | null;
  read_at: Date | null;
  created_at: Date;
  updated_at: Date;
  actors: NotificationActorRecord[] | null;
};

/**
 * Actors are resolved once per row with a lateral join against the bounded array,
 * preserving the array's order. A second query per row would be an N+1 that grows
 * with the page size.
 */
const SELECT_COLUMNS = `
  n.id, n.recipient_id, n.kind, n.actor_count, n.recent_actor_ids,
  n.subject_type, n.subject_id, n.preview, n.read_at, n.created_at, n.updated_at,
  (
    SELECT json_agg(
             json_build_object(
               'accountId', a.id,
               'username', pr.username,
               'displayName', pr.display_name,
               'avatarKey', pr.avatar_key
             ) ORDER BY actor.ord
           )
      FROM unnest(n.recent_actor_ids) WITH ORDINALITY AS actor(id, ord)
      JOIN accounts a ON a.id = actor.id
      JOIN user_profiles pr ON pr.account_id = a.id
  ) AS actors
`;

const toRecord = (row: RawRow): NotificationRecord => ({
  id: row.id,
  recipientId: row.recipient_id,
  kind: row.kind,
  actors: row.actors ?? [],
  actorCount: row.actor_count,
  subjectType: row.subject_type,
  subjectId: row.subject_id,
  preview: row.preview,
  read: row.read_at !== null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

@Injectable()
export class PostgresNotificationRepository implements NotificationStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  public async upsert(write: NotificationWrite): Promise<NotificationRecord | null> {
    const result = await this.pools.pool().query<{ id: string }>(
      `INSERT INTO notifications (
         id, recipient_id, kind, actor_id, subject_type, subject_id, group_key,
         actor_count, recent_actor_ids, preview
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, ARRAY[$4]::uuid[], $8)
       ON CONFLICT (recipient_id, group_key) DO UPDATE SET
         -- The newest actor is the face of the row; the list keeps the last five,
         -- newest first, with the acting account moved to the front exactly once.
         -- Bounded to five by this LIMIT as well as by the table's CHECK: the
         -- constraint is the backstop, the LIMIT is what keeps the update legal.
         recent_actor_ids = (
           SELECT array_agg(actor_id ORDER BY ord)
             FROM (
               SELECT actor_id, ord
                 FROM (
                   SELECT DISTINCT ON (actor_id) actor_id, ord
                     FROM (
                       SELECT EXCLUDED.actor_id AS actor_id, 0 AS ord
                       UNION ALL
                       SELECT existing.actor_id, existing.ord
                         FROM unnest(notifications.recent_actor_ids)
                              WITH ORDINALITY AS existing(actor_id, ord)
                     ) AS candidates
                    ORDER BY actor_id, ord
                 ) AS deduped
                ORDER BY ord
                LIMIT 5
             ) AS bounded
         ),
         -- Counted only when this actor was not already the most recent face,
         -- so a repeated like from the same person does not become "2 people".
         actor_count = notifications.actor_count
           + CASE WHEN notifications.recent_actor_ids[1] = EXCLUDED.actor_id THEN 0 ELSE 1 END,
         preview = COALESCE(EXCLUDED.preview, notifications.preview),
         kind = EXCLUDED.kind,
         subject_type = COALESCE(EXCLUDED.subject_type, notifications.subject_type),
         subject_id = COALESCE(EXCLUDED.subject_id, notifications.subject_id),
         -- An updated row is unread again: a new like on an old post is news.
         read_at = NULL
       RETURNING id`,
      [
        write.id,
        write.recipientId,
        write.kind,
        write.actorId,
        write.subjectType,
        write.subjectId,
        write.groupKey,
        write.preview,
      ],
    );

    const id = result.rows[0]?.id;
    return id === undefined ? null : this.find(write.recipientId, id);
  }

  public async find(
    recipientId: string,
    notificationId: string,
  ): Promise<NotificationRecord | null> {
    const result = await this.pools
      .pool()
      .query<RawRow>(
        `SELECT ${SELECT_COLUMNS} FROM notifications n WHERE n.id = $1 AND n.recipient_id = $2`,
        [notificationId, recipientId],
      );
    const row = result.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  public async list(query: NotificationQuery): Promise<NotificationPage> {
    // One row beyond the page, so `hasMore` is a fact rather than a guess.
    const result = await this.pools.pool().query<RawRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM notifications n
        WHERE n.recipient_id = $1
          AND ($2::boolean IS FALSE OR n.read_at IS NULL)
          AND ($3::uuid IS NULL OR n.id < $3::uuid)
        ORDER BY n.id DESC
        LIMIT $4`,
      [query.recipientId, query.unreadOnly, query.cursor, query.limit + 1],
    );

    const rows = result.rows.slice(0, query.limit);
    const unread = await this.unreadCount(query.recipientId);

    return {
      items: rows.map(toRecord),
      hasMore: result.rows.length > query.limit,
      unreadCount: unread,
    };
  }

  public async unreadCount(recipientId: string): Promise<number> {
    const result = await this.pools.pool().query<{
      count: string;
    }>('SELECT count(*)::text AS count FROM notifications WHERE recipient_id = $1 AND read_at IS NULL', [recipientId]);
    return Number(result.rows[0]?.count ?? '0');
  }

  public async markRead(recipientId: string, notificationId: string): Promise<boolean> {
    const result = await this.pools.pool().query(
      `UPDATE notifications SET read_at = now()
        WHERE id = $1 AND recipient_id = $2 AND read_at IS NULL`,
      [notificationId, recipientId],
    );

    // A row already read is not a failure: the caller's intent is satisfied.
    if ((result.rowCount ?? 0) > 0) return true;

    const existing = await this.find(recipientId, notificationId);
    return existing !== null;
  }

  public async markAllRead(recipientId: string): Promise<number> {
    const result = await this.pools
      .pool()
      .query(
        'UPDATE notifications SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL',
        [recipientId],
      );
    return result.rowCount ?? 0;
  }
}
