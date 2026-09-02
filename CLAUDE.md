# ОКНОТИКА maintenance notes

## Architecture

- The marketing site is static under the repository root. Keep the approved V2.27 composition outside the explicit team, aluminum, article, and operational allowlists.
- `admin-app/` is a private Node.js 24 + `node:sqlite` editor. It must never be served from the marketing document root.
- Public article truth is `/var/lib/oknotika-admin/article-releases/active`, a relative symlink to one immutable release. The Node service can be offline while nginx serves that release.
- Article working state (`current_revision_id`/`state`) is separate from public state (`published_revision_id`/`public_state`). Saving or restoring a draft must not change public output.
- Articles persist an explicit `content_kind`. Weekly digests use one shared server-side contract on ingestion, editor revision, restore and public render: one ordered Markdown list with 3–5 top-level items, 1–20 unique HTTPS sources, and weekly text limits. Legacy imports remain legacy.
- Tuesday automation has one bearer-authenticated `POST /api/ingestion/weekly-drafts` capability. `issueId` plus monotonic `contentVersion` makes retries idempotent; manual edits and durable publish/withdraw audit history permanently block machine overwrite, including after operational rollback.
- Telegram is fixed at `https://t.me/oknotika`; the shipped YouTube, VK and FUTUCHAT defaults are `https://youtube.com/@oknotika`, `https://vk.ru/oknotika` and `https://t.me/FUTU_CHAT`. Confirmed changes render and atomically activate a new immutable article release; a database-only social setting is not treated as public.
- Social-default upgrades persist a pending migration record. Startup reconciles the old active manifest first, then atomically activates those pending values in a schema-4 immutable release; the record is cleared only after the active release represents the transition.
- Publisher order is: acquire crash-recoverable lock, build one prospective snapshot, render/validate staging, immutable rename, atomic active switch, then synchronize DB/audit. Startup reconciliation derives public state from the active manifest.
- Whole-release rollback is not an editor HTTP capability. It is available only through the root-invoked `npm run rollback-release` operator CLI described in `deploy/README_ZHENYA.md`.
- Application rollback from schema 4 to the preceding schema-3 binary must first run the current operator CLI with `--application-schema 3`; that guarded step activates an old-readable article release and matching social snapshot before the application symlink moves.
- Backup uses the same publisher lock while snapshotting SQLite, immutable releases, and `active`. Restore verification must prove DB, symlink, manifest, release rows, articles, and revisions agree.

## Security invariants

- Admin auth uses one exact local username and a versioned bounded-scrypt password record loaded only from protected credential files. Login has one-use pre-auth CSRF and generic failures.
- Initial setup and rotation use the root-only Docker credential helper; never put plaintext passwords or direct credential values in source, environment, argv, logs, SQLite, or evidence.
- SQLite, credentials, sessions, uploads, previews, raw portraits, staging, and generated runtime releases stay outside Git, the ZIP, and nginx public root.
- The weekly bearer token is a mandatory systemd encrypted credential and is validated both when configuration loads and at the authenticator boundary. It cannot list assets or use editor capabilities.
- Preview is authenticated, unguessable, self-contained on the admin origin, `no-store`, and `noindex`.
- Withdrawn article directories have a release marker consumed by nginx so the detail URL returns HTTP 410 with the generated gone body.

## Standard commands

```bash
cd admin-app
npm ci
npm run lint
npm test
npm run test:security
npm run build
npm run render:fixture

cd ..
python3 -m unittest discover -s tests -v
python3 scripts/check_generated_articles.py var/test-release
python3 scripts/check_deploy_package.py .
python3 scripts/check_final_documentation.py .
python3 scripts/scan_release_zip.py release/oknotika-final.zip
```

Production-only gates remain on Linux: `nginx -t`, `systemd-analyze verify`, live public/admin/weekly-ingestion smoke tests, local login/logout/rotation/revocation, reusable weekly-cover registration, and encrypted off-host backup/restore. See `README.md`, `admin-app/ENROLLMENT.md`, `docs/WEEKLY_INGESTION.md`, and `deploy/README_ZHENYA.md` before changing deployment or auth behavior.
