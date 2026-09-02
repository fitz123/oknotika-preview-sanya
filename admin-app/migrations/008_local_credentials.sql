PRAGMA foreign_keys = ON;

ALTER TABLE configured_editors
ADD COLUMN credential_fingerprint TEXT
CHECK (credential_fingerprint IS NULL OR length(credential_fingerprint) = 64);
