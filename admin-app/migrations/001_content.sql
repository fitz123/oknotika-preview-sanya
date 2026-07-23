PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE configured_editors (
  id INTEGER PRIMARY KEY,
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (issuer, subject)
);

CREATE TABLE assets (
  id INTEGER PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  private_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE articles (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'withdrawn')),
  current_revision_id INTEGER REFERENCES article_revisions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE article_revisions (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  publication_at TEXT NOT NULL,
  lead TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  legacy_eyebrow TEXT,
  legacy_meta_description TEXT,
  legacy_listing_excerpt TEXT,
  cover_asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  cover_alt TEXT NOT NULL,
  source_url TEXT,
  created_by INTEGER NOT NULL REFERENCES configured_editors(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  restored_from_id INTEGER REFERENCES article_revisions(id) ON DELETE RESTRICT,
  UNIQUE (article_id, revision_number)
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('staging', 'complete')),
  manifest_json TEXT,
  previous_release_id TEXT REFERENCES releases(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  activated_at TEXT
);

CREATE TABLE release_articles (
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  revision_id INTEGER NOT NULL REFERENCES article_revisions(id) ON DELETE RESTRICT,
  public_state TEXT NOT NULL CHECK (public_state IN ('published', 'withdrawn')),
  PRIMARY KEY (release_id, article_id)
);

CREATE TABLE site_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_release_id TEXT REFERENCES releases(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  editor_id INTEGER REFERENCES configured_editors(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  article_id INTEGER REFERENCES articles(id) ON DELETE RESTRICT,
  revision_id INTEGER REFERENCES article_revisions(id) ON DELETE RESTRICT,
  release_id TEXT REFERENCES releases(id) ON DELETE RESTRICT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX article_revisions_article_idx ON article_revisions(article_id, revision_number DESC);
CREATE INDEX articles_state_idx ON articles(state);
CREATE INDEX audit_events_created_idx ON audit_events(created_at);

CREATE TRIGGER articles_slug_is_immutable
BEFORE UPDATE OF slug ON articles
BEGIN
  SELECT RAISE(ABORT, 'article slug is immutable');
END;

CREATE TRIGGER article_revisions_are_immutable_on_update
BEFORE UPDATE ON article_revisions
BEGIN
  SELECT RAISE(ABORT, 'article revisions are immutable');
END;

CREATE TRIGGER article_revisions_are_immutable_on_delete
BEFORE DELETE ON article_revisions
BEGIN
  SELECT RAISE(ABORT, 'article revisions are immutable');
END;

INSERT OR IGNORE INTO site_state (singleton, active_release_id, updated_at)
VALUES (1, NULL, '1970-01-01T00:00:00.000Z');
