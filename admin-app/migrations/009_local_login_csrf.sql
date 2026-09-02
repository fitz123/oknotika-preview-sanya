PRAGMA foreign_keys = ON;

CREATE TABLE local_login_csrf_tokens (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  browser_binding_hash TEXT NOT NULL CHECK (length(browser_binding_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX local_login_csrf_expiry_idx
ON local_login_csrf_tokens(expires_at);
