-- ============================================================================
--  0005_forum_categories.sql
--
--  The starter category tree.
--
--  Why a migration rather than a seed script: categories are not demo data. A
--  forum with no categories has nowhere to post, so every environment — including
--  production on its first deploy — needs these rows to exist before the feature
--  works. A seed script that only runs in development would leave production with
--  an empty forum and no way to create a category through the API, since category
--  management is a moderation concern that does not exist yet.
--
--  The insert is idempotent on `path`, so re-running it against a database where a
--  moderator has since renamed a category does not resurrect the old row.
-- ============================================================================

INSERT INTO forum_categories (id, slug, name, path, parent_id)
VALUES
  ('018f0000-0000-7000-8000-00000000c001', 'general', 'General', '/general', NULL)
ON CONFLICT (path) DO NOTHING;

INSERT INTO forum_categories (id, slug, name, path, parent_id)
SELECT '018f0000-0000-7000-8000-00000000c002', 'help', 'Help and support', '/general/help',
       (SELECT id FROM forum_categories WHERE path = '/general')
ON CONFLICT (path) DO NOTHING;

INSERT INTO forum_categories (id, slug, name, path, parent_id)
SELECT '018f0000-0000-7000-8000-00000000c003', 'feedback', 'Product feedback', '/feedback',
       NULL
ON CONFLICT (path) DO NOTHING;

COMMENT ON TABLE forum_categories IS
  'Starter tree is seeded by migration 0005; category management is a moderation feature.';
