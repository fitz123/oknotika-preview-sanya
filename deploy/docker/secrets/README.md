# Compose secret files

The deployment host has three effective secret records under
`/var/home/oknotika/admin-app/data/secrets/`:

- `local-credentials/current/username`
- `local-credentials/current/password-hash`
- `weekly-ingest-token`

The root-only interactive helper creates immutable local-credential generation
directories and atomically switches `current`; never create or edit those two
files by hand. Every record contains exactly one value followed by a newline.
On Linux, credential records use owner/group `root:1000` and mode `0640` so the
non-root admin container (`1000:1000`) can read the mounted Compose secrets.
Do not commit runtime files or copy `.example` placeholders into place. The
examples are deliberately invalid and are never mounted by Compose.
