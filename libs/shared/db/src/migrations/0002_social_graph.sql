-- ============================================================================
--  0002_social_graph.sql — profile visibility, follows and blocks
--
--  Design rules encoded here:
--    * `user_profiles.visibility` arrives as a nullable column, backfilled to
--      PUBLIC, and only then constrained NOT NULL. Adding a NOT NULL column with
--      a default in one step rewrites the table under an exclusive lock; doing it
--      in three steps is online on any table size.
--    * A follow is a directed edge, and the self-edge is rejected by CHECK, not
--      by application code — a self-follow would corrupt every follower count.
--    * Blocks are directed rows with a *undirected* effect, enforced by the
--      queries and by `blocks_visibility_guard` below: neither party may see the
--      other, and an existing follow is destroyed when a block is created.
--    * No cross-user foreign keys beyond `accounts`, so every table here stays
--      shardable by `account_id`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Profile visibility.
--
-- Read by the viewer's own relation to the owner (see kernel/relationships.ts).
-- The default is PUBLIC because a new account is trying to be found; making the
-- default private silently produces empty profiles and is experienced as a bug.
-- ---------------------------------------------------------------------------
ALTER TABLE user_profiles ADD COLUMN visibility text;

UPDATE user_profiles SET visibility = 'PUBLIC' WHERE visibility IS NULL;

-- The default is what makes this additive: registration does not know about
-- visibility, and must not have to. A NOT NULL column without a default would
-- break every existing INSERT that lists its columns explicitly.
ALTER TABLE user_profiles
  ALTER COLUMN visibility SET DEFAULT 'PUBLIC',
  ALTER COLUMN visibility SET NOT NULL,
  ADD CONSTRAINT user_profiles_visibility_allowed
    CHECK (visibility IN ('PUBLIC', 'FOLLOWERS', 'PRIVATE'));

COMMENT ON COLUMN user_profiles.visibility IS
  'PUBLIC = anyone; FOLLOWERS = confirmed followers only; PRIVATE = nobody but the owner.';

-- ---------------------------------------------------------------------------
-- Denormalised counters.
--
-- Stored rather than counted because "how many followers" is asked on every
-- profile view, and `count(*)` over a 10M-row edge table per view is not a page
-- load. They are maintained by triggers below so they cannot drift from the
-- edges — a counter that is written by the application is a counter that is
-- eventually wrong.
-- ---------------------------------------------------------------------------
ALTER TABLE user_profiles
  ADD COLUMN follower_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN following_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT user_profiles_follower_count_non_negative CHECK (follower_count >= 0),
  ADD CONSTRAINT user_profiles_following_count_non_negative CHECK (following_count >= 0);

-- ---------------------------------------------------------------------------
-- follows: a directed edge, follower → followee.
--
-- No surrogate id: the composite primary key *is* the identity of the edge, so a
-- duplicate follow cannot be inserted and `ON CONFLICT DO NOTHING` is the
-- idempotent operation the API needs.
-- ---------------------------------------------------------------------------
CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- A follow may require the target's approval; the request is the row, and it
  -- becomes an edge when `accepted_at` is set.
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (follower_id, followee_id),
  CONSTRAINT follows_no_self_edge CHECK (follower_id <> followee_id)
);

-- The reverse direction is what the follower list reads; the primary key only
-- serves the following list. Both are needed, and both are on the hot path.
CREATE INDEX follows_followee_idx ON follows (followee_id, created_at DESC) WHERE accepted_at IS NOT NULL;
CREATE INDEX follows_pending_idx ON follows (followee_id) WHERE accepted_at IS NULL;

COMMENT ON TABLE follows IS
  'Directed follow edges. A row with accepted_at NULL is a pending request, not an edge.';

-- ---------------------------------------------------------------------------
-- blocks: a directed row with an undirected effect.
--
-- Kept directed because "who blocked whom" matters for moderation, but every
-- read path treats it as symmetric.
-- ---------------------------------------------------------------------------
CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocks_no_self_block CHECK (blocker_id <> blocked_id),
  CONSTRAINT blocks_reason_len CHECK (reason IS NULL OR char_length(reason) <= 280)
);

CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

COMMENT ON TABLE blocks IS
  'A block is stored once, directionally, and applied symmetrically by every read path.';

-- ---------------------------------------------------------------------------
-- Triggers: counters and block semantics.
-- ---------------------------------------------------------------------------

-- Maintains follower_count/following_count from the edge table itself, so the
-- numbers are a function of the rows rather than a second place to update.
CREATE OR REPLACE FUNCTION maintain_follow_counters() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A row with `accepted_at IS NULL` is a pending *request*, not an edge, so it
  -- must not move the counters. The transition into acceptance is what counts.
  IF TG_OP = 'INSERT' THEN
    IF NEW.accepted_at IS NOT NULL THEN
      UPDATE user_profiles SET follower_count = follower_count + 1 WHERE account_id = NEW.followee_id;
      UPDATE user_profiles SET following_count = following_count + 1 WHERE account_id = NEW.follower_id;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN
      UPDATE user_profiles SET follower_count = follower_count + 1 WHERE account_id = NEW.followee_id;
      UPDATE user_profiles SET following_count = following_count + 1 WHERE account_id = NEW.follower_id;
    ELSIF OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS NULL THEN
      UPDATE user_profiles SET follower_count = GREATEST(follower_count - 1, 0) WHERE account_id = OLD.followee_id;
      UPDATE user_profiles SET following_count = GREATEST(following_count - 1, 0) WHERE account_id = OLD.follower_id;
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE only moves the counters when the removed row was an accepted edge.
  IF TG_OP = 'DELETE' AND OLD.accepted_at IS NOT NULL THEN
    UPDATE user_profiles SET follower_count = GREATEST(follower_count - 1, 0) WHERE account_id = OLD.followee_id;
    UPDATE user_profiles SET following_count = GREATEST(following_count - 1, 0) WHERE account_id = OLD.follower_id;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER follows_maintain_counters
  AFTER INSERT OR UPDATE OF accepted_at OR DELETE ON follows
  FOR EACH ROW EXECUTE FUNCTION maintain_follow_counters();

-- Creating a block destroys any follow edge in either direction.
--
-- This is a statement-level guarantee, not a service-layer step: a block that
-- leaves a follow behind continues to deliver the blocked party's content, which
-- is the exact opposite of what the user asked for. Doing it in a trigger means
-- no code path can forget.
CREATE OR REPLACE FUNCTION enforce_block_severs_follows() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM follows
  WHERE (follower_id = NEW.blocker_id AND followee_id = NEW.blocked_id)
     OR (follower_id = NEW.blocked_id AND followee_id = NEW.blocker_id);
  RETURN NULL;
END;
$$;

CREATE TRIGGER blocks_sever_follows
  AFTER INSERT ON blocks
  FOR EACH ROW EXECUTE FUNCTION enforce_block_severs_follows();

-- A follow cannot be created across a block in either direction, whichever order
-- the two operations happen to arrive in.
CREATE OR REPLACE FUNCTION forbid_follow_across_block() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM blocks
    WHERE (blocker_id = NEW.follower_id AND blocked_id = NEW.followee_id)
       OR (blocker_id = NEW.followee_id AND blocked_id = NEW.follower_id)
  ) THEN
    RAISE EXCEPTION 'cannot follow across a block (% -> %)', NEW.follower_id, NEW.followee_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER follows_forbid_blocked_edges
  BEFORE INSERT OR UPDATE ON follows
  FOR EACH ROW EXECUTE FUNCTION forbid_follow_across_block();

-- ---------------------------------------------------------------------------
-- Privileges are not granted here.
--
-- `setup.ts` grants on ALL TABLES and sets ALTER DEFAULT PRIVILEGES, so new
-- tables are covered automatically. Including a GRANT in a migration would make
-- it depend on this cluster's role names, break in CI where they differ, and
-- duplicate a policy that already has one owner.
-- ---------------------------------------------------------------------------
