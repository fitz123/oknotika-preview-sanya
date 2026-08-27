# Docker Compose package layout

This directory contains the secret-free two-container deployment definition.
The production procedure, host nginx configuration, backup and rollback commands
are in the Russian operator runbook `README_ZHENYA.md`; the copy-ready host
configuration is `host-nginx.conf`.

- `admin` publishes only `127.0.0.1:8000` and stores its database, uploads,
  previews, backups and immutable article releases in separate named volumes.
- `public` publishes only `127.0.0.1:8001`, serves the bundled public site and
  sees only the article-release volume, read-only.
- Both application processes run as non-root users with read-only root filesystems.
- OIDC and weekly-ingestion values are read only from files under `/run/secrets`.

The files in `secrets/` are placeholders only. Never put real values in a tracked
file, an image, `compose.env`, a build argument or a Compose `environment` value.
