-- ============================================================================
--  0006_messaging.sql
--
--  Direct and group conversations.
--
--  Four decisions this schema makes, and why each is a constraint rather than a
--  convention:
--
--  1. **A direct thread is unique per unordered pair.** `dm_key` is the two
--     account ids sorted and joined, with a unique index on it. Without that,
--     two people pressing "message" at the same time create two conversations
--     that then diverge — the classic split-brain of a chat feature, and the
--     reason a plain `(a_id, b_id)` pair must not be trusted to be consistent in
--     both directions.
--
--  2. **Read state is a cursor per participant, not a per-message flag.**
--     `last_read_message_id` advances and never retreats (enforced by the trigger
--     below). A `read_at` column per message would need one row per reader per
--     message — quadratic storage for a linear question — and an out-of-order
--     event could mark a read message unread again.
--
--  3. **`can_view_thread()` is the single authority**, and it denies a blocked
--     pair in both directions, including history. Every read path calls it; there
--     is no second, weaker check in the API.
--
--  4. **Messages are immutable.** There is no `edited_at` and no update path. An
--     edit in a conversation rewrites something the other person has already
--     read and replied to, which is a different product. Deleting is soft, via
--     `deleted_at`, so a reply keeps its context and the thread's message count
--     stays a fact.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Threads
-- ---------------------------------------------------------------------------
CREATE TABLE message_threads (
  id          uuid PRIMARY KEY,
  kind        text NOT NULL
    CONSTRAINT message_threads_kind_allowed CHECK (kind IN ('DIRECT', 'GROUP')),

  -- For a DIRECT thread, the pair. Both null for a GROUP thread, where membership
  -- lives in message_participants.
  direct_a_id uuid REFERENCES accounts (id) ON DELETE CASCADE,
  direct_b_id uuid REFERENCES accounts (id) ON DELETE CASCADE,

  -- The unordered pair, materialised. Never null for DIRECT, always null for GROUP.
  dm_key      text,

  -- The creator and, for a group, the moderator who may rename, add and lock.
  -- A direct thread has an owner too — whoever opened it — but the owner grants no
  -- extra power over a two-person conversation, which is why nothing reads it
  -- except membership.
  owner_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,

  title       text,
  locked      boolean NOT NULL DEFAULT false,

  -- Denormalised for the list: the newest message's timestamp and a short preview.
  -- A list of 20 threads would otherwise join 20 lateral subqueries against the
  -- largest table in the feature.
  last_message_at     timestamptz NOT NULL DEFAULT now(),
  last_message_preview text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT message_threads_shape CHECK (
    (kind = 'DIRECT'
      AND direct_a_id IS NOT NULL AND direct_b_id IS NOT NULL
      AND dm_key IS NOT NULL AND direct_a_id <> direct_b_id)
    OR
    (kind = 'GROUP'
      AND direct_a_id IS NULL AND direct_b_id IS NULL AND dm_key IS NULL)
  ),
  CONSTRAINT message_threads_title_len CHECK (
    title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 80
  ),
  CONSTRAINT message_threads_group_needs_title CHECK (kind <> 'GROUP' OR title IS NOT NULL)
);

-- One direct conversation per pair, whichever direction it was opened from.
CREATE UNIQUE INDEX message_threads_dm_key ON message_threads (dm_key)
  WHERE dm_key IS NOT NULL;

-- The inbox: newest activity first per participant (joined through participants).
CREATE INDEX message_threads_recent_idx ON message_threads (last_message_at DESC);

CREATE TRIGGER message_threads_set_updated_at
  BEFORE UPDATE ON message_threads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Participants
--
-- Membership is explicit rows for both kinds. A direct thread therefore reads its
-- two participants from the same table a group does, so "am I a member" has one
-- implementation rather than a branch on thread kind.
-- ---------------------------------------------------------------------------
CREATE TABLE message_participants (
  thread_id  uuid NOT NULL REFERENCES message_threads (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,

  -- The cursor. Null means "has never opened the thread", which is different from
  -- "has read nothing": both show every message as unread, but only the latter has
  -- a position to advance.
  last_read_message_id uuid,

  joined_at  timestamptz NOT NULL DEFAULT now(),
  -- Leaving is a timestamp, not a delete: the rows are what make a thread's
  -- membership auditable, and a re-join must not lose the read cursor.
  left_at    timestamptz,

  PRIMARY KEY (thread_id, account_id)
);

CREATE INDEX message_participants_account_idx ON message_participants (account_id, thread_id);

-- ---------------------------------------------------------------------------
-- Messages
--
-- `id` is uuidv7 from the application, so `ORDER BY id` is publication order and
-- the keyset cursor is the id itself — no `(created_at, id)` tie-breaker, and the
-- inbox query is a single-column comparison.
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id         uuid PRIMARY KEY,
  thread_id  uuid NOT NULL REFERENCES message_threads (id) ON DELETE CASCADE,
  sender_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  body       text NOT NULL,
  -- Set when the sender deletes it. The row stays so a reply keeps its context and
  -- the thread's count does not silently change under a reader.
  deleted_at timestamptz,
  -- The sender's idempotency key. A retried send (a timeout, a flaky mobile
  -- connection) carries the same value, and the unique index below turns the retry
  -- into a read of the original rather than a second message.
  client_id  uuid,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT messages_body_not_blank CHECK (btrim(body) <> ''),
  CONSTRAINT messages_body_len CHECK (char_length(body) <= 4000)
);

CREATE INDEX messages_thread_idx ON messages (thread_id, id DESC);

-- Idempotency, scoped to the sender inside the thread: two people may of course
-- pick the same client id, and only one sender's retry should collapse.
CREATE UNIQUE INDEX messages_client_id_idx
  ON messages (thread_id, sender_id, client_id)
  WHERE client_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Visibility
--
-- One authority, like can_view_post(). The block check is first because it defeats
-- membership: a group does not give a blocked account a way back in, and leaving a
-- group does not give it a way to keep reading.
-- ---------------------------------------------------------------------------
-- Named for messaging, not `can_view_thread` — migration 0004 already defines a
-- function of that name for forum threads, and two authorities sharing a name is
-- exactly the ambiguity this codebase avoids everywhere else.
CREATE OR REPLACE FUNCTION can_view_conversation(p_thread uuid, p_viewer uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_viewer IS NULL THEN false
    ELSE COALESCE(
      (
        SELECT EXISTS (
                 SELECT 1 FROM message_participants p
                  WHERE p.thread_id = t.id AND p.account_id = p_viewer
                    AND p.left_at IS NULL
               )
               AND NOT EXISTS (
                 -- Any block between the viewer and *any other* live participant
                 -- hides the thread. In a group this is deliberately strict: a
                 -- conversation the viewer cannot fully see is not readable.
                 SELECT 1
                   FROM message_participants other
                   JOIN blocks b
                     ON (b.blocker_id = p_viewer AND b.blocked_id = other.account_id)
                     OR (b.blocker_id = other.account_id AND b.blocked_id = p_viewer)
                  WHERE other.thread_id = t.id
                    AND other.left_at IS NULL
                    AND other.account_id <> p_viewer
               )
          FROM message_threads t
         WHERE t.id = p_thread
      ),
      false
    )
  END;
$$;

COMMENT ON FUNCTION can_view_conversation(uuid, uuid) IS
  'Sole authority on conversation visibility. Denies a block in either direction, including history.';

-- ---------------------------------------------------------------------------
-- Keeps the denormalised summary honest.
--
-- The unread count is not stored: it is a count of other people's messages after
-- the reader's cursor, which is an index range scan on messages (thread_id, id).
-- Storing it would need one row per participant per message to stay correct.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION maintain_thread_last_message() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE message_threads
       SET last_message_at = NEW.created_at,
           last_message_preview = left(regexp_replace(NEW.body, '\s+', ' ', 'g'), 120)
     WHERE id = NEW.thread_id
       -- Only move the summary forward: a message inserted with an older id (a
       -- backfill, or a clock skew) must not rewind the list ordering. The NULL
       -- arm matters: a brand-new thread has no summary yet, and `NULL <= x` is
       -- NULL, so without it the first message of every conversation is dropped.
       AND (last_message_at IS NULL OR last_message_at <= NEW.created_at);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER messages_maintain_thread
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION maintain_thread_last_message();

-- ---------------------------------------------------------------------------
-- Read cursors advance, never retreat.
--
-- An out-of-order event from another device must not mark a message unread. The
-- comparison is on ids because they are uuidv7: ordering by id is ordering by time.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION advance_read_cursor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_read_message_id IS NOT NULL
     AND OLD.last_read_message_id IS NOT NULL
     AND NEW.last_read_message_id < OLD.last_read_message_id THEN
    NEW.last_read_message_id := OLD.last_read_message_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER message_participants_advance_cursor
  BEFORE UPDATE ON message_participants
  FOR EACH ROW EXECUTE FUNCTION advance_read_cursor();
