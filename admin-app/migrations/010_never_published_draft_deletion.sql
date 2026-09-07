PRAGMA foreign_keys = ON;

ALTER TABLE articles
ADD COLUMN generation_token TEXT
CHECK (
  generation_token IS NULL
  OR (
    length(generation_token) = 32
    AND generation_token NOT GLOB '*[^0-9a-f]*'
  )
);

UPDATE articles
SET generation_token = lower(hex(randomblob(16)))
WHERE generation_token IS NULL;

CREATE UNIQUE INDEX articles_generation_token_idx
ON articles(generation_token);

CREATE TRIGGER articles_assign_generation_token
AFTER INSERT ON articles
WHEN NEW.generation_token IS NULL
BEGIN
  UPDATE articles
  SET generation_token = lower(hex(randomblob(16)))
  WHERE id = NEW.id;
END;

CREATE TRIGGER articles_generation_token_is_immutable
BEFORE UPDATE OF generation_token ON articles
WHEN OLD.generation_token IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'article generation token is immutable');
END;

CREATE TABLE private_previews (
  preview_id TEXT PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES article_revisions(id) ON DELETE RESTRICT,
  directory TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE INDEX private_previews_revision_idx
ON private_previews(revision_id);

DROP TRIGGER article_revision_sources_are_immutable_on_delete;

CREATE TRIGGER article_revision_sources_are_immutable_on_delete
BEFORE DELETE ON article_revision_sources
WHEN NOT EXISTS (
  SELECT 1
  FROM article_revisions r
  JOIN articles a ON a.id = r.article_id
  WHERE r.id = OLD.revision_id
    AND a.state = 'draft'
    AND a.public_state IS NULL
    AND a.published_revision_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM release_articles ra WHERE ra.article_id = a.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM audit_events ae
      WHERE ae.article_id = a.id
        AND ae.event_type IN ('article.published', 'article.withdrawn')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'article revision sources are immutable');
END;

DROP TRIGGER article_revisions_are_immutable_on_delete;

CREATE TRIGGER article_revisions_are_immutable_on_delete
BEFORE DELETE ON article_revisions
WHEN NOT EXISTS (
  SELECT 1
  FROM articles a
  WHERE a.id = OLD.article_id
    AND a.state = 'draft'
    AND a.public_state IS NULL
    AND a.published_revision_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM release_articles ra WHERE ra.article_id = a.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM audit_events ae
      WHERE ae.article_id = a.id
        AND ae.event_type IN ('article.published', 'article.withdrawn')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'article revisions are immutable');
END;

CREATE TRIGGER articles_require_no_public_history_on_delete
BEFORE DELETE ON articles
WHEN OLD.state <> 'draft'
  OR OLD.public_state IS NOT NULL
  OR OLD.published_revision_id IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM release_articles ra WHERE ra.article_id = OLD.id
  )
  OR EXISTS (
    SELECT 1 FROM audit_events ae
    WHERE ae.article_id = OLD.id
      AND ae.event_type IN ('article.published', 'article.withdrawn')
  )
BEGIN
  SELECT RAISE(ABORT, 'articles with public history are immutable');
END;

CREATE TRIGGER public_transition_audit_is_immutable_on_delete
BEFORE DELETE ON audit_events
WHEN OLD.event_type IN ('article.published', 'article.withdrawn')
BEGIN
  SELECT RAISE(ABORT, 'public transition audit events are immutable');
END;
