-- ============================================================================
--  0008_tools.sql
--
--  The one tool that needs a server: notes.
--
--  Everything else in the tools module (PDF, QR, calculator, age, budget, period
--  tracker) is arithmetic over content the person already has, and it stays in the
--  browser. Notes are the exception because they are the one thing people expect to
--  find again on another device — and that is a decision with a cost, so the schema
--  is explicit about what is stored and what is not:
--
--  1. **One owner, no sharing.** There is no `note_shares` table and no visibility
--     column, because "share a note" is a feature with its own permission model and
--     a half-built version of it is a data leak. A note is readable only by its
--     author, and `can_view_note()` is the single place that says so.
--
--  2. **Pinning is a column, not a derived order.** `pinned` cannot be inferred from
--     `updated_at`; a pinned note is pinned exactly because it is not the most
--     recent thing its author touched. The index is `(owner_id, pinned DESC,
--     updated_at DESC, id)` so the list order is an index scan and cannot drift
--     from the service's comparator.
--
--  3. **The title is derived at write time.** Like an article's excerpt: a list of
--     200 notes must not parse 200 bodies to draw 200 rows. `title` is filled by
--     `noteTitleOf()` in the kernel, so the list and the note agree by construction.
--
--  4. **Nothing here is soft-deleted.** A note is a scrap of text; an undo stack of
--     tombstones for it would be storage with no reader. Delete is delete.
-- ============================================================================

CREATE TABLE notes (
  id         uuid PRIMARY KEY,
  owner_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,

  -- Derived from the first line at write time; empty when the body starts with prose.
  title      text NOT NULL DEFAULT '',
  body       text NOT NULL,

  pinned     boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- The kernel's ceiling, enforced where it cannot be bypassed. A note is text someone
  -- typed, not a file: 20 000 characters is already a long afternoon.
  CONSTRAINT notes_body_len CHECK (char_length(body) BETWEEN 1 AND 20000),
  CONSTRAINT notes_title_len CHECK (char_length(title) <= 80),
  CONSTRAINT notes_body_not_blank CHECK (btrim(body) <> '')
);

-- The only ordering the list ever asks for. Ties are broken by `id` so two notes saved in
-- the same millisecond do not swap places between requests.
CREATE INDEX notes_owner_order_idx
  ON notes (owner_id, pinned DESC, updated_at DESC, id);

CREATE TRIGGER notes_set_updated_at
  BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
--  can_view_note()
--
--  A note has exactly one reader: its owner. Stating that as a function rather than an
--  inline `owner_id = $1` is what lets every route — get, list, update, delete — share one
--  definition, and what makes a future "shared note" a change in one place.
-- ============================================================================

CREATE OR REPLACE FUNCTION can_view_note(p_note_id uuid, p_viewer_id uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM notes n
     WHERE n.id = p_note_id
       AND n.owner_id = p_viewer_id
  );
$$;

COMMENT ON FUNCTION can_view_note(uuid, uuid) IS
  'A note is visible only to its author. One definition for every route.';
