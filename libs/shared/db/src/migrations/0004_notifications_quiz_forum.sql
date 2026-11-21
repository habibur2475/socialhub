-- ============================================================================
--  0004_notifications_quiz_forum.sql
--
--  Three features, one migration, because they share a single mechanism: each
--  produces notifications, and the notification table must exist before any of
--  them can. Splitting them would mean three migrations with a hard ordering
--  dependency and no benefit.
--
--  Notifications
--  -------------
--  Collapsing is a *storage* concern, not a presentation one. Ten likes on one
--  post from ten people is one row with a count and a set of recent actors, so a
--  viral post cannot make the list unusable. Storing ten rows and collapsing at
--  read time would move the cost from a rare write to every page load.
--
--  Quiz
--  ----
--  Questions and options are separate tables rather than a JSON blob on the set:
--  a graded attempt must cite *option ids*, and a foreign key is what makes "this
--  answer refers to an option that exists" a database guarantee rather than a
--  convention.
--
--  Forum
--  -----
--  Categories are a materialised path, like scopes, so a category tree is
--  readable in one query and an ancestor check is a string prefix comparison.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id           uuid PRIMARY KEY,
  recipient_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind         text NOT NULL
    CONSTRAINT notifications_kind_allowed CHECK (kind IN (
      'FOLLOW', 'LIKE', 'REPLY', 'MENTION', 'REPOST', 'QUIZ_RESULT', 'THREAD_ANSWER'
    )),
  -- The most recent actor. For a collapsed notification this is the newest one,
  -- which is the face the list shows.
  actor_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- What the notification is *about*: a post, a thread, a quiz set. Nullable
  -- because a FOLLOW has no subject other than the actor.
  subject_type text
    CONSTRAINT notifications_subject_type_allowed CHECK (
      subject_type IS NULL OR subject_type IN ('post', 'thread', 'quiz_set', 'account')
    ),
  subject_id   uuid,
  -- Collapsing key: one row per (recipient, kind, subject). Two likes on two
  -- different posts stay two rows; ten likes on one post become one.
  group_key    text NOT NULL,

  actor_count  integer NOT NULL DEFAULT 1,
  -- The last few actors, newest first, bounded. This is what "and 9 others" reads
  -- from, and the bound is what keeps one row from growing without limit.
  recent_actor_ids uuid[] NOT NULL DEFAULT '{}',

  -- Denormalised for the list query: the body excerpt or actor name, so rendering
  -- a notification never needs a join back to the subject.
  preview      text,

  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notifications_actor_count_positive CHECK (actor_count >= 1),
  CONSTRAINT notifications_recent_actors_bounded CHECK (array_length(recent_actor_ids, 1) IS NULL
    OR array_length(recent_actor_ids, 1) <= 5)
);

-- The list query: one recipient, newest first, unread ahead of read.
CREATE INDEX notifications_inbox_idx ON notifications (recipient_id, updated_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (recipient_id) WHERE read_at IS NULL;
-- Collapsing lookup on write.
CREATE UNIQUE INDEX notifications_group_key ON notifications (recipient_id, group_key);

CREATE TRIGGER notifications_set_updated_at
  BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE notifications IS
  'Collapsed per (recipient, group_key): actor_count and recent_actor_ids carry the summary.';

-- ---------------------------------------------------------------------------
-- Quiz
-- ---------------------------------------------------------------------------
CREATE TABLE quiz_sets (
  id          uuid PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text,
  visibility  text NOT NULL DEFAULT 'PUBLIC'
    CONSTRAINT quiz_sets_visibility_allowed CHECK (visibility IN ('PUBLIC', 'FOLLOWERS', 'PRIVATE')),
  -- Grading can be instant (the answer key is known) or manual (written answers).
  -- Storing the mode rather than inferring it means a set cannot be graded two
  -- different ways depending on which code path runs.
  grading_mode text NOT NULL DEFAULT 'AUTO'
    CONSTRAINT quiz_sets_grading_mode_allowed CHECK (grading_mode IN ('AUTO', 'MANUAL')),
  time_limit_seconds integer
    CONSTRAINT quiz_sets_time_limit_sane CHECK (time_limit_seconds IS NULL
      OR (time_limit_seconds >= 30 AND time_limit_seconds <= 86400)),
  attempt_count integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quiz_sets_title_len CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  CONSTRAINT quiz_sets_attempt_count_non_negative CHECK (attempt_count >= 0)
);

CREATE INDEX quiz_sets_owner_idx ON quiz_sets (owner_id, id DESC);
CREATE INDEX quiz_sets_recent_idx ON quiz_sets (id DESC);

CREATE TRIGGER quiz_sets_set_updated_at
  BEFORE UPDATE ON quiz_sets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE quiz_questions (
  id         uuid PRIMARY KEY,
  set_id     uuid NOT NULL REFERENCES quiz_sets (id) ON DELETE CASCADE,
  prompt     text NOT NULL,
  -- Position in the set. Unique per set so two questions cannot claim the same
  -- slot, which would make "question 3 of 10" ambiguous.
  position   integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quiz_questions_prompt_len CHECK (char_length(btrim(prompt)) BETWEEN 1 AND 1000),
  CONSTRAINT quiz_questions_position_positive CHECK (position >= 1),
  CONSTRAINT quiz_questions_position_unique UNIQUE (set_id, position)
);

CREATE INDEX quiz_questions_set_idx ON quiz_questions (set_id, position);

CREATE TABLE quiz_options (
  id          uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES quiz_questions (id) ON DELETE CASCADE,
  label       text NOT NULL,
  position    integer NOT NULL,
  is_correct  boolean NOT NULL DEFAULT false,

  CONSTRAINT quiz_options_label_len CHECK (char_length(btrim(label)) BETWEEN 1 AND 500),
  CONSTRAINT quiz_options_position_positive CHECK (position >= 1),
  CONSTRAINT quiz_options_position_unique UNIQUE (question_id, position)
);

CREATE INDEX quiz_options_question_idx ON quiz_options (question_id, position);

-- An attempt is a student's run at a set. `submitted_at` separates a run in
-- progress from a graded one, and is what makes resuming possible.
CREATE TABLE quiz_attempts (
  id           uuid PRIMARY KEY,
  set_id       uuid NOT NULL REFERENCES quiz_sets (id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  started_at   timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  -- Points earned and available. Integers because the score of an auto-graded
  -- multiple-choice set is a count of correct options, not money.
  score        integer,
  max_score    integer,
  graded_by    uuid REFERENCES accounts (id) ON DELETE SET NULL,

  CONSTRAINT quiz_attempts_score_range CHECK (
    (score IS NULL AND max_score IS NULL)
    OR (score IS NOT NULL AND max_score IS NOT NULL AND score >= 0 AND score <= max_score)
  ),
  CONSTRAINT quiz_attempts_submitted_after_start CHECK (submitted_at IS NULL OR submitted_at >= started_at)
);

CREATE INDEX quiz_attempts_account_idx ON quiz_attempts (account_id, started_at DESC);
CREATE INDEX quiz_attempts_set_idx ON quiz_attempts (set_id, started_at DESC);

-- One row per answered question, plus a child table for the chosen options.
--
-- The split exists because a multi-select question has several correct answers. A
-- single nullable `option_id` column cannot express "these three", and a plain
-- `uuid[]` would lose the foreign key that makes "this answer cites an option that
-- exists" a guarantee. The composite key on the child table is what stops the same
-- option being selected twice for one question.
CREATE TABLE quiz_answers (
  attempt_id  uuid NOT NULL REFERENCES quiz_attempts (id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES quiz_questions (id) ON DELETE CASCADE,
  -- Written answers for MANUAL sets. A row may carry options, a text answer, or
  -- both, which is how a set can mix multiple choice with short answers.
  text_answer text,

  PRIMARY KEY (attempt_id, question_id),
  CONSTRAINT quiz_answers_text_len CHECK (text_answer IS NULL OR char_length(text_answer) <= 5000)
);

CREATE TABLE quiz_answer_options (
  attempt_id  uuid NOT NULL,
  question_id uuid NOT NULL,
  option_id   uuid NOT NULL REFERENCES quiz_options (id) ON DELETE CASCADE,

  PRIMARY KEY (attempt_id, question_id, option_id),
  FOREIGN KEY (attempt_id, question_id)
    REFERENCES quiz_answers (attempt_id, question_id) ON DELETE CASCADE
);

CREATE INDEX quiz_answer_options_option_idx ON quiz_answer_options (option_id);

-- ---------------------------------------------------------------------------
-- Forum
-- ---------------------------------------------------------------------------
CREATE TABLE forum_categories (
  id         uuid PRIMARY KEY,
  slug       text NOT NULL,
  name       text NOT NULL,
  -- Materialised path, as with scopes: ancestry is a prefix comparison.
  path       text NOT NULL,
  parent_id  uuid REFERENCES forum_categories (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT forum_categories_slug_shape CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  CONSTRAINT forum_categories_path_shape CHECK (path ~ '^/[a-z0-9-]+(/[a-z0-9-]+)*$'),
  CONSTRAINT forum_categories_path_unique UNIQUE (path)
);

CREATE INDEX forum_categories_path_prefix_idx ON forum_categories (path text_pattern_ops);

CREATE TABLE forum_threads (
  id            uuid PRIMARY KEY,
  category_id   uuid NOT NULL REFERENCES forum_categories (id) ON DELETE RESTRICT,
  author_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  title         text NOT NULL,
  body          text NOT NULL,
  answer_count  integer NOT NULL DEFAULT 0,
  -- Pinned threads sort first. Kept on the row rather than in a separate table so
  -- the list query stays one index scan.
  pinned        boolean NOT NULL DEFAULT false,
  locked        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT forum_threads_title_len CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  CONSTRAINT forum_threads_body_len CHECK (char_length(btrim(body)) BETWEEN 1 AND 20000),
  CONSTRAINT forum_threads_answer_count_non_negative CHECK (answer_count >= 0)
);

-- Pinned first, then newest. The partial index on `pinned` keeps the common
-- unpinned path small.
CREATE INDEX forum_threads_category_idx ON forum_threads (category_id, id DESC);
CREATE INDEX forum_threads_recent_idx ON forum_threads (id DESC);

CREATE TRIGGER forum_threads_set_updated_at
  BEFORE UPDATE ON forum_threads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE forum_answers (
  id         uuid PRIMARY KEY,
  thread_id  uuid NOT NULL REFERENCES forum_threads (id) ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  body       text NOT NULL,
  -- An accepted answer is the thread author's endorsement. At most one per thread,
  -- enforced by the partial unique index below.
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT forum_answers_body_len CHECK (char_length(btrim(body)) BETWEEN 1 AND 20000)
);

CREATE INDEX forum_answers_thread_idx ON forum_answers (thread_id, id);
CREATE UNIQUE INDEX forum_answers_one_accepted ON forum_answers (thread_id)
  WHERE accepted_at IS NOT NULL;

CREATE TRIGGER forum_answers_set_updated_at
  BEFORE UPDATE ON forum_answers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Counters
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION maintain_thread_answer_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE forum_threads SET answer_count = answer_count + 1 WHERE id = NEW.thread_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE forum_threads SET answer_count = GREATEST(answer_count - 1, 0) WHERE id = OLD.thread_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER forum_answers_maintain_count
  AFTER INSERT OR DELETE ON forum_answers
  FOR EACH ROW EXECUTE FUNCTION maintain_thread_answer_count();

CREATE OR REPLACE FUNCTION maintain_quiz_attempt_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE quiz_sets SET attempt_count = attempt_count + 1 WHERE id = NEW.set_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE quiz_sets SET attempt_count = GREATEST(attempt_count - 1, 0) WHERE id = OLD.set_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER quiz_attempts_maintain_count
  AFTER INSERT OR DELETE ON quiz_attempts
  FOR EACH ROW EXECUTE FUNCTION maintain_quiz_attempt_count();

-- ---------------------------------------------------------------------------
-- Visibility for quiz sets and forum threads.
--
-- Same shape as can_view_post(), and for the same reason: one authority, applied
-- inside the query, so no read path invents a weaker rule. Quiz sets reuse
-- can_view_post()'s block and follow semantics without duplicating them, because
-- a set has no audience snapshot — it is a live visibility, not an addressed one.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION can_view_quiz_set(set_id uuid, viewer uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN viewer IS NULL THEN false
    ELSE COALESCE(
      (
        SELECT CASE
          WHEN s.owner_id = can_view_quiz_set.viewer THEN true
          WHEN EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = can_view_quiz_set.viewer AND b.blocked_id = s.owner_id)
                OR (b.blocker_id = s.owner_id AND b.blocked_id = can_view_quiz_set.viewer)
          ) THEN false
          WHEN s.visibility = 'PRIVATE' THEN false
          WHEN s.visibility = 'PUBLIC' THEN true
          WHEN s.visibility = 'FOLLOWERS' THEN EXISTS (
            SELECT 1 FROM follows f
             WHERE f.follower_id = can_view_quiz_set.viewer
               AND f.followee_id = s.owner_id
               AND f.accepted_at IS NOT NULL
          )
          ELSE false
        END
        FROM quiz_sets s
        WHERE s.id = can_view_quiz_set.set_id
      ),
      false
    )
  END;
$$;

-- Forum threads are readable by anyone signed in unless the author is blocked.
-- A forum whose content hides behind a follow graph is not a forum; the category
-- is public by design and moderation is what handles abuse.
CREATE OR REPLACE FUNCTION can_view_thread(thread_id uuid, viewer uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN viewer IS NULL THEN false
    ELSE COALESCE(
      (
        SELECT NOT EXISTS (
          SELECT 1 FROM blocks b
           WHERE (b.blocker_id = can_view_thread.viewer AND b.blocked_id = t.author_id)
              OR (b.blocker_id = t.author_id AND b.blocked_id = can_view_thread.viewer)
        )
        FROM forum_threads t
        WHERE t.id = can_view_thread.thread_id
      ),
      false
    )
  END;
$$;

COMMENT ON FUNCTION can_view_quiz_set(uuid, uuid) IS
  'Sole authority on quiz set visibility. Denies on block, PRIVATE and unknown values.';
COMMENT ON FUNCTION can_view_thread(uuid, uuid) IS
  'Sole authority on forum thread visibility: readable unless a block exists either way.';
