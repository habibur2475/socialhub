/**
 * Messaging persistence.
 *
 * Three things are done in SQL rather than in TypeScript, each for a reason:
 *
 *   - **`can_view_conversation()`** gates every read. It is the same predicate the
 *     indexes were designed for, and putting it in the `WHERE` means a forbidden
 *     thread is `null`, not a row the service had to remember to filter.
 *   - **The unread count is a correlated `count(*)`** on `(thread_id, id DESC)` with
 *     the reader's cursor as the lower bound. Storing a counter would need one row
 *     per reader per message to stay correct after a delete or a re-join.
 *   - **The pair facts for a direct thread are one query.** Two `SELECT`s (blocks,
 *     follows) plus a third for an existing thread would be three round trips on the
 *     hottest path in the feature — the moment someone presses "message".
 *
 * Participant rows are aggregated with `json_agg` rather than fetched per thread: a
 * list of 20 conversations would otherwise be 20 more queries, and the whole list is
 * one indexed scan plus one join.
 */

import { Inject, Injectable } from '@nestjs/common';

import { DatabasePools, type Queryable } from '../../../database/pool.js';
import type { ThreadKind } from '@socialhub/kernel';
import type {
  ConversationPage,
  ConversationRecord,
  ConversationStore,
  DirectPairFacts,
  MessagePage,
  MessageRecord,
  SendFacts,
} from '../application/ports.js';

type ParticipantJson = {
  account_id: string;
  username: string;
  display_name: string;
  avatar_key: string | null;
  owner: boolean;
  left_at: string | null;
};

type RawConversationRow = {
  id: string;
  kind: ThreadKind;
  title: string | null;
  owner_id: string;
  locked: boolean;
  last_message_at: Date;
  last_message_preview: string | null;
  unread_count: string;
  participants: ParticipantJson[];
};

type RawMessageRow = {
  id: string;
  thread_id: string;
  sender_id: string;
  body: string;
  deleted_at: Date | null;
  created_at: Date;
  client_id: string | null;
  username: string;
  display_name: string;
  avatar_key: string | null;
};

/**
 * The participant projection, reused by every query that returns a conversation.
 *
 * A left member stays in the array: the transcript shows who used to be there, and
 * dropping them would rewrite history. `left_at` is what the reader checks.
 */
const PARTICIPANTS_JSON = `
  COALESCE((
    SELECT json_agg(
             json_build_object(
               'account_id', p.account_id,
               'username', pr.username,
               'display_name', pr.display_name,
               'avatar_key', pr.avatar_key,
               'owner', p.account_id = t.owner_id,
               'left_at', p.left_at
             ) ORDER BY p.joined_at
           )
      FROM message_participants p
      JOIN user_profiles pr ON pr.account_id = p.account_id
     WHERE p.thread_id = t.id
  ), '[]'::json)`;

/**
 * Unread: messages after the reader's cursor, not written by the reader.
 *
 * The cursor is `last_read_message_id`; when it is null every message counts, which
 * is what a reader who has never opened the thread should see.
 */
const UNREAD_COUNT = `
  (SELECT count(*)::text
     FROM messages m
    WHERE m.thread_id = t.id
      AND m.sender_id <> $1
      AND m.deleted_at IS NULL
      AND (reader.last_read_message_id IS NULL OR m.id > reader.last_read_message_id))`;

const CONVERSATION_COLUMNS = `
  t.id, t.kind, t.title, t.owner_id, t.locked,
  t.last_message_at, t.last_message_preview,
  ${UNREAD_COUNT} AS unread_count,
  ${PARTICIPANTS_JSON} AS participants`;

const MESSAGE_COLUMNS = `
  m.id, m.thread_id, m.sender_id, m.body, m.deleted_at, m.created_at, m.client_id,
  pr.username, pr.display_name, pr.avatar_key`;

const toConversation = (row: RawConversationRow): ConversationRecord => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  ownerId: row.owner_id,
  locked: row.locked,
  lastMessageAt: row.last_message_at,
  lastMessagePreview: row.last_message_preview,
  unreadCount: Number(row.unread_count),
  participants: row.participants.map((participant) => ({
    accountId: participant.account_id,
    username: participant.username,
    displayName: participant.display_name,
    avatarKey: participant.avatar_key,
    owner: participant.owner,
    leftAt: participant.left_at === null ? null : new Date(participant.left_at),
  })),
});

const toMessage = (row: RawMessageRow): MessageRecord => ({
  id: row.id,
  threadId: row.thread_id,
  senderId: row.sender_id,
  body: row.body,
  deleted: row.deleted_at !== null,
  createdAt: row.created_at,
  clientId: row.client_id,
  sender: {
    accountId: row.sender_id,
    username: row.username,
    displayName: row.display_name,
    avatarKey: row.avatar_key,
  },
});

/**
 * The inbox cursor.
 *
 * `last_message_at` is not unique, so the id is the tie-breaker: an encoding that used
 * only the timestamp would skip a thread that shares its instant with the page
 * boundary — the exact bug the feed avoids by keying on the id alone.
 */
const encodeCursor = (row: { lastMessageAt: Date; id: string }): string =>
  `${row.lastMessageAt.toISOString()}|${row.id}`;

const decodeCursor = (cursor: string): { at: string; id: string } | null => {
  const [at, id] = cursor.split('|');
  if (at === undefined || id === undefined) return null;
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return null;
  return { at: parsed.toISOString(), id };
};

@Injectable()
export class PostgresConversationRepository implements ConversationStore {
  public constructor(@Inject(DatabasePools) private readonly pools: DatabasePools) {}

  public async directPairFacts(
    senderId: string,
    recipientId: string,
  ): Promise<DirectPairFacts | null> {
    const result = await this.pools.pool().query<{
      exists: boolean;
      blocked: boolean;
      sender_follows: boolean;
      recipient_follows: boolean;
      thread_id: string | null;
    }>(
      `SELECT EXISTS (SELECT 1 FROM accounts a WHERE a.id = $2) AS exists,
              EXISTS (
                SELECT 1 FROM blocks b
                 WHERE (b.blocker_id = $1 AND b.blocked_id = $2)
                    OR (b.blocker_id = $2 AND b.blocked_id = $1)
              ) AS blocked,
              EXISTS (
                SELECT 1 FROM follows f
                 WHERE f.follower_id = $1 AND f.followee_id = $2 AND f.accepted_at IS NOT NULL
              ) AS sender_follows,
              EXISTS (
                SELECT 1 FROM follows f
                 WHERE f.follower_id = $2 AND f.followee_id = $1 AND f.accepted_at IS NOT NULL
              ) AS recipient_follows,
              (
                SELECT t.id FROM message_threads t
                 WHERE t.dm_key = (SELECT string_agg(k, ':' ORDER BY k)
                                     FROM unnest(ARRAY[$1, $2]::text[]) AS k)
              ) AS thread_id`,
      [senderId, recipientId],
    );

    const row = result.rows[0];
    if (row === undefined || !row.exists) return null;

    return {
      blocked: row.blocked,
      senderFollowsRecipient: row.sender_follows,
      recipientFollowsSender: row.recipient_follows,
      threadId: row.thread_id,
    };
  }

  public async sendFacts(threadId: string, senderId: string): Promise<SendFacts | null> {
    const result = await this.pools.pool().query<{
      kind: ThreadKind;
      owner_id: string;
      locked: boolean;
      is_member: boolean;
      blocked: boolean;
      participant_ids: string[];
    }>(
      `SELECT t.kind, t.owner_id, t.locked,
              EXISTS (
                SELECT 1 FROM message_participants p
                 WHERE p.thread_id = t.id AND p.account_id = $2 AND p.left_at IS NULL
              ) AS is_member,
              EXISTS (
                SELECT 1 FROM message_participants other
                  JOIN blocks b
                    ON (b.blocker_id = $2 AND b.blocked_id = other.account_id)
                    OR (b.blocker_id = other.account_id AND b.blocked_id = $2)
                 WHERE other.thread_id = t.id
                   AND other.left_at IS NULL
                   AND other.account_id <> $2
              ) AS blocked,
              ARRAY(
                SELECT p.account_id FROM message_participants p
                 WHERE p.thread_id = t.id AND p.left_at IS NULL
              ) AS participant_ids
         FROM message_threads t
        WHERE t.id = $1`,
      [threadId, senderId],
    );

    const row = result.rows[0];
    if (row === undefined) return null;

    return {
      threadId,
      kind: row.kind,
      ownerId: row.owner_id,
      locked: row.locked,
      isMember: row.is_member,
      blocked: row.blocked,
      participantIds: row.participant_ids,
    };
  }

  public async ensureDirectThread(input: {
    readonly id: string;
    readonly ownerId: string;
    readonly otherId: string;
  }): Promise<ConversationRecord> {
    const dmKey = [input.ownerId, input.otherId].sort().join(':');

    // `ON CONFLICT` on the unordered key, then a plain read: an insert that lost the
    // race returns no row, and the winner's row is what both callers must see.
    await this.pools.pool().query(
      `INSERT INTO message_threads (id, kind, direct_a_id, direct_b_id, dm_key, owner_id)
       VALUES ($1, 'DIRECT', LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), $4, $2)
       ON CONFLICT (dm_key) WHERE dm_key IS NOT NULL DO NOTHING`,
      [input.id, input.ownerId, input.otherId, dmKey],
    );

    const threadId = await this.pools
      .pool()
      .query<{ id: string }>('SELECT id FROM message_threads WHERE dm_key = $1', [dmKey]);

    const id = threadId.rows[0]?.id;
    // The insert or the conflicting row always exists, so a missing id is a bug in
    // the unique index rather than a state to recover from.
    if (id === undefined) throw new Error(`direct thread for ${dmKey} vanished after upsert`);

    await this.pools.pool().query(
      `INSERT INTO message_participants (thread_id, account_id)
       VALUES ($1, $2), ($1, $3)
       ON CONFLICT (thread_id, account_id) DO NOTHING`,
      [id, input.ownerId, input.otherId],
    );

    // Read as the owner: a caller cannot be shown a thread it does not belong to,
    // even one it just created, because the same read path serves the list.
    const created = await this.readConversation(this.pools.pool(), input.ownerId, id);
    if (created === null) throw new Error(`direct thread ${id} not readable by its creator`);
    return created;
  }

  public async createGroupThread(input: {
    readonly id: string;
    readonly ownerId: string;
    readonly title: string;
    readonly memberIds: readonly string[];
  }): Promise<ConversationRecord> {
    await this.pools.transaction(async (client) => {
      await client.query(
        `INSERT INTO message_threads (id, kind, owner_id, title)
         VALUES ($1, 'GROUP', $2, $3)`,
        [input.id, input.ownerId, input.title],
      );

      await client.query(
        // `$1` must be cast: inside UNION ALL an untyped parameter is inferred as
        // text, and a text cannot be inserted into a uuid column.
        `INSERT INTO message_participants (thread_id, account_id)
         SELECT $1::uuid, member FROM unnest($2::uuid[]) AS member
         UNION ALL SELECT $1::uuid, $3::uuid`,
        [input.id, input.memberIds, input.ownerId],
      );
    });

    const created = await this.readConversation(this.pools.pool(), input.ownerId, input.id);
    if (created === null) throw new Error(`group thread ${input.id} not readable by its owner`);
    return created;
  }

  public async listConversations(
    viewerId: string,
    page: { readonly limit: number; readonly cursor: string | null; readonly unreadOnly: boolean },
  ): Promise<ConversationPage> {
    const decoded = page.cursor === null ? null : decodeCursor(page.cursor);
    // A cursor that does not decode is treated as the first page rather than an
    // error: a stale link should show the inbox, not a 400.
    const cursor = decoded === null ? null : decoded;

    const result = await this.pools.pool().query<RawConversationRow & { unread_threads: string }>(
      `SELECT ${CONVERSATION_COLUMNS},
              (SELECT count(*)::text FROM (
                 SELECT 1
                   FROM message_participants p2
                   JOIN message_threads t2 ON t2.id = p2.thread_id
                   LEFT JOIN message_participants reader2
                     ON reader2.thread_id = t2.id AND reader2.account_id = $1
                    WHERE p2.account_id = $1 AND p2.left_at IS NULL
                      AND EXISTS (
                        SELECT 1 FROM messages m2
                         WHERE m2.thread_id = t2.id
                           AND m2.sender_id <> $1
                           AND m2.deleted_at IS NULL
                           AND (reader2.last_read_message_id IS NULL
                                OR m2.id > reader2.last_read_message_id)
                      )
               ) unread) AS unread_threads
         FROM message_threads t
         JOIN message_participants me
           ON me.thread_id = t.id AND me.account_id = $1 AND me.left_at IS NULL
         LEFT JOIN message_participants reader
           ON reader.thread_id = t.id AND reader.account_id = $1
        WHERE can_view_conversation(t.id, $1)
          AND ($2::timestamptz IS NULL
               OR t.last_message_at < $2::timestamptz
               OR (t.last_message_at = $2::timestamptz AND t.id < $3::uuid))
          AND ($4::boolean = false
               OR EXISTS (
                 SELECT 1 FROM messages m3
                  WHERE m3.thread_id = t.id
                    AND m3.sender_id <> $1
                    AND m3.deleted_at IS NULL
                    AND (reader.last_read_message_id IS NULL
                         OR m3.id > reader.last_read_message_id)
               ))
        ORDER BY t.last_message_at DESC, t.id DESC
        LIMIT $5`,
      [
        viewerId,
        cursor?.at ?? null,
        cursor?.id ?? null,
        page.unreadOnly,
        // One extra row answers "is there another page" without a second count.
        page.limit + 1,
      ],
    );

    const rows = result.rows.slice(0, page.limit);
    return {
      items: rows.map(toConversation),
      hasMore: result.rows.length > page.limit,
      unreadThreads: Number(result.rows[0]?.unread_threads ?? 0),
    };
  }

  public async findConversation(
    viewerId: string,
    threadId: string,
  ): Promise<ConversationRecord | null> {
    return this.readConversation(this.pools.pool(), viewerId, threadId);
  }

  /** The one conversation read, shared by every path that must respect visibility. */
  private async readConversation(
    queryable: Queryable,
    viewerId: string,
    threadId: string,
  ): Promise<ConversationRecord | null> {
    const result = await queryable.query<RawConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS}
         FROM message_threads t
         LEFT JOIN message_participants reader
           ON reader.thread_id = t.id AND reader.account_id = $1
        WHERE t.id = $2
          AND can_view_conversation(t.id, $1)
        LIMIT 1`,
      [viewerId, threadId],
    );

    const row = result.rows[0];
    return row === undefined ? null : toConversation(row);
  }

  public async listMessages(
    viewerId: string,
    threadId: string,
    page: { readonly limit: number; readonly before: string | null },
  ): Promise<MessagePage> {
    const result = await this.pools.pool().query<RawMessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM messages m
         JOIN user_profiles pr ON pr.account_id = m.sender_id
        WHERE m.thread_id = $2
          AND can_view_conversation($2, $1)
          AND ($3::uuid IS NULL OR m.id < $3::uuid)
        ORDER BY m.id DESC
        LIMIT $4`,
      [viewerId, threadId, page.before, page.limit + 1],
    );

    const rows = result.rows.slice(0, page.limit);
    return { items: rows.map(toMessage), hasMore: result.rows.length > page.limit };
  }

  public async appendMessage(input: {
    readonly id: string;
    readonly threadId: string;
    readonly senderId: string;
    readonly body: string;
    readonly clientId: string | null;
  }): Promise<MessageRecord> {
    const result = await this.pools.pool().query<RawMessageRow>(
      `WITH inserted AS (
         INSERT INTO messages (id, thread_id, sender_id, body, client_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (thread_id, sender_id, client_id) WHERE client_id IS NOT NULL
         DO NOTHING
         RETURNING *
       )
       SELECT ${MESSAGE_COLUMNS}
         FROM inserted m
         JOIN user_profiles pr ON pr.account_id = m.sender_id`,
      [input.id, input.threadId, input.senderId, input.body, input.clientId],
    );

    const row = result.rows[0];
    if (row !== undefined) return toMessage(row);

    // The conflict arm: this exact client id already produced a message, so the
    // retry returns the original instead of a duplicate or an error.
    if (input.clientId !== null) {
      const existing = await this.findMessageByClientId(
        input.threadId,
        input.senderId,
        input.clientId,
      );
      if (existing !== null) return existing;
    }

    throw new Error(`message ${input.id} could not be stored`);
  }

  public async findMessageByClientId(
    threadId: string,
    senderId: string,
    clientId: string,
  ): Promise<MessageRecord | null> {
    const result = await this.pools.pool().query<RawMessageRow>(
      `SELECT ${MESSAGE_COLUMNS}
         FROM messages m
         JOIN user_profiles pr ON pr.account_id = m.sender_id
        WHERE m.thread_id = $1 AND m.sender_id = $2 AND m.client_id = $3
        LIMIT 1`,
      [threadId, senderId, clientId],
    );

    const row = result.rows[0];
    return row === undefined ? null : toMessage(row);
  }

  public async markRead(viewerId: string, threadId: string, messageId: string): Promise<number> {
    // The trigger clamps the cursor to move forward only, so this statement is safe
    // to run on every visit and from two devices at once.
    await this.pools.pool().query(
      `UPDATE message_participants
          SET last_read_message_id = $3
        WHERE thread_id = $1 AND account_id = $2 AND left_at IS NULL`,
      [threadId, viewerId, messageId],
    );

    return this.unreadCount(viewerId, threadId);
  }

  public async unreadCount(viewerId: string, threadId: string): Promise<number> {
    const result = await this.pools.pool().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM messages m
         JOIN message_participants reader
           ON reader.thread_id = m.thread_id AND reader.account_id = $1
        WHERE m.thread_id = $2
          AND m.sender_id <> $1
          AND m.deleted_at IS NULL
          AND (reader.last_read_message_id IS NULL OR m.id > reader.last_read_message_id)`,
      [viewerId, threadId],
    );

    return Number(result.rows[0]?.count ?? '0');
  }

  public async addMembers(input: {
    readonly threadId: string;
    readonly memberIds: readonly string[];
  }): Promise<readonly string[]> {
    const result = await this.pools.pool().query<{ account_id: string }>(
      `INSERT INTO message_participants (thread_id, account_id)
       SELECT $1::uuid, member FROM unnest($2::uuid[]) AS member
       ON CONFLICT (thread_id, account_id) DO UPDATE
         -- A returning member keeps the read cursor the schema deliberately
         -- preserves; only the leave flag is cleared.
         SET left_at = NULL
         WHERE message_participants.left_at IS NOT NULL
       RETURNING account_id`,
      [input.threadId, input.memberIds],
    );

    return result.rows.map((row) => row.account_id);
  }

  public async removeMember(threadId: string, accountId: string): Promise<boolean> {
    const result = await this.pools.pool().query(
      `UPDATE message_participants
          SET left_at = now()
        WHERE thread_id = $1 AND account_id = $2 AND left_at IS NULL`,
      [threadId, accountId],
    );

    return (result.rowCount ?? 0) > 0;
  }

  public async updateGroup(
    viewerId: string,
    threadId: string,
    patch: { readonly title?: string; readonly locked?: boolean },
  ): Promise<ConversationRecord | null> {
    const assignments: string[] = [];
    const values: unknown[] = [threadId];

    if (patch.title !== undefined) {
      values.push(patch.title);
      assignments.push(`title = $${values.length}`);
    }
    if (patch.locked !== undefined) {
      values.push(patch.locked);
      assignments.push(`locked = $${values.length}`);
    }
    if (assignments.length === 0) return null;

    await this.pools.pool().query(
      `UPDATE message_threads SET ${assignments.join(', ')}
        WHERE id = $1 AND kind = 'GROUP'`,
      values,
    );

    // Re-read as the caller: the update cannot change visibility, and returning the
    // row the caller is allowed to see keeps one shape for the controller.
    return this.findConversation(viewerId, threadId);
  }

  public async deleteMessage(
    threadId: string,
    messageId: string,
    senderId: string,
  ): Promise<MessageRecord | null> {
    const result = await this.pools.pool().query<RawMessageRow>(
      `WITH removed AS (
         -- The body is deliberately left in place: the row is soft-deleted, and
         -- erasing the text here would make the delete irreversible while the
         -- transcript still needs a stable placeholder.
         UPDATE messages SET deleted_at = now()
          WHERE id = $2 AND thread_id = $1 AND sender_id = $3 AND deleted_at IS NULL
          RETURNING *
       )
       SELECT ${MESSAGE_COLUMNS}
         FROM removed m
         JOIN user_profiles pr ON pr.account_id = m.sender_id`,
      [threadId, messageId, senderId],
    );

    const row = result.rows[0];
    return row === undefined ? null : toMessage(row);
  }
}

export { encodeCursor };
