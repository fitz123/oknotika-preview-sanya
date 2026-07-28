PRAGMA foreign_keys = ON;

ALTER TABLE articles
ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'legacy'
CHECK (content_kind IN ('legacy', 'weekly_digest'));

UPDATE articles
SET content_kind = 'weekly_digest'
WHERE id IN (SELECT article_id FROM weekly_ingestion_issues);
