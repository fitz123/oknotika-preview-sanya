# Docker Compose package layout

This directory contains the secret-free two-container deployment definition.
The production procedure, host nginx configuration, backup and rollback commands
are in the Russian operator runbook `README_ZHENYA.md`; the copy-ready host
configuration is `host-nginx.conf`.

- `admin` publishes only `127.0.0.1:8000` and bind-mounts its database,
  uploads, previews, backups and immutable article releases from
  `/var/home/oknotika/admin-app/data/`.
- `public` publishes only `127.0.0.1:8001`, serves the bundled public site and
  sees only `admin-app/data/article-releases`, read-only. The reserved
  `/var/home/oknotika/public-app/data/` directory is not mounted.
- Both application processes run as non-root users with read-only root filesystems.
- The local username/password hash and weekly-ingestion value are sourced from private files under
  `/var/home/oknotika/admin-app/data/secrets/` and exposed only to `admin`
  under `/run/secrets`.

The files in `secrets/` are format examples only. The root-only interactive
`configure-local-credentials.sh` helper creates the real local credential
generation. Never put real values in the source tree, an image, `compose.env`,
a build argument or a Compose `environment` value.
