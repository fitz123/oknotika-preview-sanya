# ОКНОТИКА maintenance notes

## Architecture

- The marketing site is static under the repository root. Keep the approved V2.27 composition outside the explicit team, aluminum, article, and operational allowlists.
- `admin-app/` is a private Node.js 24 + `node:sqlite` editor. It must never be served from the marketing document root.
- Public article truth is `/var/lib/oknotika-admin/article-releases/active`, a relative symlink to one immutable release. The Node service can be offline while nginx serves that release.
- Article working state (`current_revision_id`/`state`) is separate from public state (`published_revision_id`/`public_state`). Saving or restoring a draft must not change public output.
- Publisher order is: acquire crash-recoverable lock, build one prospective snapshot, render/validate staging, immutable rename, atomic active switch, then synchronize DB/audit. Startup reconciliation derives public state from the active manifest.
- Backup uses the same publisher lock while snapshotting SQLite, immutable releases, and `active`. Restore verification must prove DB, symlink, manifest, release rows, articles, and revisions agree.

## Security invariants

- Telegram auth uses official discovery, Authorization Code Flow, PKCE S256, exact callback, server-side one-use state/nonce/browser binding, pinned RS256, bounded JWKS refresh, and allowlist by verified `(issuer, sub)` only.
- First enrollment uses `npm run bootstrap-editor`; never authorize from username, phone, an unverified JWT payload, or a subject pasted into project files.
- SQLite, credentials, sessions, uploads, previews, raw portraits, staging, and generated runtime releases stay outside Git, the ZIP, and nginx public root.
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

Production-only gates remain on Linux: `nginx -t`, `systemd-analyze verify`, live public/admin smoke tests, real Telegram login/logout/revocation, and encrypted off-host backup/restore. See `README.md`, `admin-app/ENROLLMENT.md`, and `deploy/README_ZHENYA.md` before changing deployment or auth behavior.
