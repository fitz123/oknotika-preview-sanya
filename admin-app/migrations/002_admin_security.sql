PRAGMA foreign_keys = ON;

ALTER TABLE configured_editors ADD COLUMN disabled_at TEXT;

CREATE TABLE oidc_login_transactions (
  state_hash TEXT PRIMARY KEY CHECK (length(state_hash) = 64),
  browser_binding_hash TEXT NOT NULL CHECK (length(browser_binding_hash) = 64),
  nonce TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  csrf_hash TEXT NOT NULL CHECK (length(csrf_hash) = 64),
  editor_id INTEGER NOT NULL REFERENCES configured_editors(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT
);

CREATE TABLE private_uploads (
  id INTEGER PRIMARY KEY,
  original_path TEXT NOT NULL UNIQUE,
  sanitized_asset_id INTEGER NOT NULL UNIQUE REFERENCES assets(id) ON DELETE RESTRICT,
  original_media_type TEXT NOT NULL CHECK (original_media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  source_bytes INTEGER NOT NULL CHECK (source_bytes > 0 AND source_bytes <= 10485760),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_by INTEGER NOT NULL REFERENCES configured_editors(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE INDEX oidc_login_expiry_idx ON oidc_login_transactions(expires_at);
CREATE INDEX admin_sessions_editor_idx ON admin_sessions(editor_id, revoked_at);
CREATE INDEX admin_sessions_expiry_idx ON admin_sessions(idle_expires_at, absolute_expires_at);
CREATE INDEX private_uploads_created_idx ON private_uploads(created_at);
