PRAGMA foreign_keys = ON;

CREATE TABLE article_revision_sources (
  id INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL REFERENCES article_revisions(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0 AND position < 20),
  url TEXT NOT NULL,
  UNIQUE (revision_id, position),
  UNIQUE (revision_id, url)
);

INSERT INTO article_revision_sources (revision_id, position, url)
SELECT id, 0, source_url
FROM article_revisions
WHERE source_url IS NOT NULL;

CREATE INDEX article_revision_sources_revision_idx
ON article_revision_sources(revision_id, position);

CREATE TRIGGER article_revision_sources_are_immutable_on_update
BEFORE UPDATE ON article_revision_sources
BEGIN
  SELECT RAISE(ABORT, 'article revision sources are immutable');
END;

CREATE TRIGGER article_revision_sources_are_immutable_on_delete
BEFORE DELETE ON article_revision_sources
BEGIN
  SELECT RAISE(ABORT, 'article revision sources are immutable');
END;

CREATE TABLE weekly_ingestion_issues (
  issue_id TEXT PRIMARY KEY,
  article_id INTEGER NOT NULL UNIQUE REFERENCES articles(id) ON DELETE RESTRICT,
  content_version INTEGER NOT NULL CHECK (content_version > 0),
  last_ingestion_revision_id INTEGER NOT NULL UNIQUE REFERENCES article_revisions(id) ON DELETE RESTRICT,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE site_social_links (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  telegram_url TEXT NOT NULL,
  youtube_url TEXT,
  vk_url TEXT,
  updated_by INTEGER REFERENCES configured_editors(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL
);

INSERT INTO site_social_links
  (singleton, telegram_url, youtube_url, vk_url, updated_by, updated_at)
VALUES
  (1, 'https://t.me/oknotika', NULL, NULL, NULL, '1970-01-01T00:00:00.000Z');
