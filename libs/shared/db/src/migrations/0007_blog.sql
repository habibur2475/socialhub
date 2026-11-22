-- ============================================================================
--  0007_blog.sql
--
--  Long-form articles.
--
--  A blog is not "a post with a longer body". Five decisions this schema makes, and
--  why each is a constraint rather than a convention:
--
--  1. **Publication is a state machine with a clock.** `status` says what the author
--     intends; `scheduled_for` says when. A scheduled article is readable at its
--     moment without a worker flipping a column — a job that misfires after a deploy
--     restarts must not delay an article by an hour, and `can_view_article()` asking
--     `now()` is what makes the timestamp authoritative.
--
--  2. **A slug is permanent and unique.** It is what a link, a share and a search
--     result point at. Renaming the title must not move the URL, so the slug is a
--     stored column that only changes deliberately.
--
--  3. **The excerpt and the reading time are stored, the body is not fetched to
--     produce the list.** A list of 20 articles would otherwise read 20 bodies of up
--     to 100 kB to render 20 two-line summaries. They are derived at write time by
--     the kernel (`excerptOf`, `readingMinutes`), so they cannot disagree with the
--     body they came from.
--
--  4. **Tags are rows, not an array.** A tag page is "articles with this tag, newest
--     first", which is an index scan on `(tag, published_at DESC)`. An array column
--     can be filtered but cannot be indexed for that ordering without a GIN index
--     plus a sort, and the composite key also makes "tag this article twice" a
--     non-event.
--
--  5. **`can_view_article()` is the single authority**, like `can_view_post()` and
--     `can_view_conversation()`. It denies a block in both directions, hides a draft
--     from everyone but its author, and publishes a scheduled article when it is due.
-- ============================================================================

CREATE TABLE articles (
  id            uuid PRIMARY KEY,
  author_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,

  -- The permalink segment. Never derived at read time: a title edit must not move a URL.
  slug          text NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL,

  -- Derived at write time from the body; see the header.
  excerpt       text NOT NULL,
  reading_minutes integer NOT NULL,

  status        text NOT NULL DEFAULT 'DRAFT',

  -- When the article becomes (or became) readable. Set on publish, preserved across
  -- an un-publish/re-publish so a corrected article does not jump to the top of the
  -- archive it has been in for a year.
  published_at  timestamptz,

  -- When a scheduled article is due. Null for every other status.
  scheduled_for timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT articles_status_allowed CHECK (
    status IN ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED')
  ),
  CONSTRAINT articles_slug_shape CHECK (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 80
  ),
  CONSTRAINT articles_title_len CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  -- Prose, so the ceiling is generous: 100 kB, and the body must not be blank.
  CONSTRAINT articles_body_not_blank CHECK (btrim(body) <> ''),
  CONSTRAINT articles_body_len CHECK (char_length(body) <= 100000),
  CONSTRAINT articles_excerpt_len CHECK (char_length(excerpt) BETWEEN 1 AND 200),
  CONSTRAINT articles_reading_minutes_positive CHECK (reading_minutes BETWEEN 1 AND 1000),
  -- A schedule without a date is unanswerable, and a date without a schedule is a lie
  -- in the other direction: a DRAFT with `scheduled_for` set would render a countdown
  -- to nothing.
  CONSTRAINT articles_schedule_pairing CHECK (
    (status = 'SCHEDULED' AND scheduled_for IS NOT NULL)
    OR (status <> 'SCHEDULED' AND scheduled_for IS NULL)
  ),
  -- Anything a reader can reach must be datable: an "published" article with no date
  -- cannot be ordered, and ordering is the whole archive.
  CONSTRAINT articles_published_dated CHECK (
    status <> 'PUBLISHED' OR published_at IS NOT NULL
  )
);

-- One permalink per article. Two articles claiming the same URL is a redirect that
-- cannot be written.
CREATE UNIQUE INDEX articles_slug_key ON articles (slug);

-- The archive, the author's list and the tag page all read this shape.
CREATE INDEX articles_published_idx ON articles (published_at DESC)
  WHERE status = 'PUBLISHED';

CREATE INDEX articles_author_idx ON articles (author_id, created_at DESC);

-- The scheduler's drive-by: which scheduled articles are due. Partial, because the
-- table is almost entirely published or draft articles and the index should say so.
CREATE INDEX articles_scheduled_idx ON articles (scheduled_for)
  WHERE status = 'SCHEDULED';

CREATE TRIGGER articles_set_updated_at
  BEFORE UPDATE ON articles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Tags
--
-- A composite primary key rather than a surrogate id: two tags on one article is
-- not a row that needs addressing, it is a set membership, and the key is what makes
-- re-tagging idempotent under a retried publish.
-- ---------------------------------------------------------------------------
CREATE TABLE article_tags (
  article_id uuid NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  tag        text NOT NULL,

  PRIMARY KEY (article_id, tag),
  CONSTRAINT article_tags_shape CHECK (tag ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(tag) <= 40)
);

-- The tag page: this tag's articles, newest first. The article join supplies the date,
-- so the index is on the tag alone; a covering index over both tables does not exist.
CREATE INDEX article_tags_tag_idx ON article_tags (tag);

-- ---------------------------------------------------------------------------
-- Visibility
--
-- One authority, like `can_view_post()`. The order of the checks is the policy:
-- authorship first (drafts and archived articles are their author's, not a public
-- page), then a block in either direction hides a published article from the reader,
-- and the clock decides a schedule. Authorship deliberately outranks the block: a
-- block between an author and one reader is not the author's to observe, and losing
-- access to your own work because a stranger blocked you would be a lever.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION can_view_article(p_article uuid, p_viewer uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_viewer IS NULL THEN false
    ELSE COALESCE(
      (
        SELECT CASE
          WHEN EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = p_viewer AND b.blocked_id = a.author_id)
                OR (b.blocker_id = a.author_id AND b.blocked_id = p_viewer)
          ) THEN false
          WHEN a.author_id = p_viewer THEN true
          -- An archived article is its author's archive, not a public page.
          WHEN a.status = 'PUBLISHED' THEN true
          -- A scheduled article is readable the moment it is due, whether or not a
          -- worker has noticed. The status is the intent; the timestamp is the fact.
          WHEN a.status = 'SCHEDULED'
               AND a.scheduled_for IS NOT NULL
               AND a.scheduled_for <= now() THEN true
          ELSE false
        END
        FROM articles a
        WHERE a.id = p_article
      ),
      -- No such article: not visible. Absence and denial are the same answer, which
      -- is what keeps a deleted draft indistinguishable from someone else's.
      false
    )
  END;
$$;

COMMENT ON FUNCTION can_view_article(uuid, uuid) IS
  'Sole authority on article visibility. Denies on block, hides drafts and archived articles, publishes a scheduled article when due.';
