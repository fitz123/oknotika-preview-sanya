#!/usr/bin/env python3
"""Static checks for the credential-free Linux deployment package."""

from __future__ import annotations

import hashlib
import json
import re
import stat
import subprocess
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"deploy package check failed: {message}")


def require_text(path: Path, *needles: str) -> str:
    if not path.is_file():
        fail(f"missing {path}")
    text = path.read_text(encoding="utf-8")
    for needle in needles:
        if needle not in text:
            fail(f"{path} does not contain {needle!r}")
    return text


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    deploy = root / "deploy"
    manifest = json.loads((deploy / "release-manifest.json").read_text(encoding="utf-8"))
    runtime = manifest.get("runtime", {})
    if runtime.get("nodeMajor") != 24 or not re.fullmatch(r"24\.\d+\.\d+", runtime.get("nodeVersion", "")):
        fail("Node 24 major and exact patch must be pinned")
    if runtime.get("sqliteProvider") != "node:sqlite" or not re.fullmatch(
        r"3\.\d+\.\d+", runtime.get("sqliteVersion", "")
    ):
        fail("bundled SQLite provider/version must be pinned")
    editorial = manifest.get("editorial", {})
    if editorial.get("publicSection") != {
        "name": "Новости",
        "path": "/articles/",
        "weeklyMaterialLabel": "Дайджест недели",
    }:
        fail("weekly news public section metadata is stale")
    ingestion = editorial.get("weeklyIngestion", {})
    if ingestion.get("path") != "/api/ingestion/weekly-drafts" \
            or ingestion.get("maximumBodyBytes") != 128 * 1024 \
            or ingestion.get("credential") != "weekly-ingest-token" \
            or ingestion.get("authority") != "create-or-update-private-weekly-draft-only":
        fail("weekly ingestion deployment contract is stale")
    if editorial.get("socialDestinations") != {
        "telegram": "https://t.me/oknotika",
        "youtube": "https://youtube.com/@oknotika",
        "vk": "https://vk.ru/oknotika",
        "futuchat": "https://t.me/FUTU_CHAT",
        "configuration": (
            "confirmed editor action atomically activates validated values in a new immutable "
            "article release; null destinations are not rendered"
        ),
    }:
        fail("official social destinations are stale")
    credentials = manifest.get("credentials", {})
    if credentials.get("provider") != "systemd LoadCredentialEncrypted" \
            or credentials.get("environmentValuesForbidden") is not True \
            or "weekly-ingest-token" not in credentials.get("weeklyCaller", []):
        fail("encrypted weekly caller credential contract is missing")
    if manifest.get("packageBoundaries", {}).get("marketing") \
            != "deploy/scripts/install-marketing.sh public_paths allowlist only":
        fail("marketing/technical package boundary is missing")

    lock_path = root / "admin-app/package-lock.json"
    lock_hash = hashlib.sha256(lock_path.read_bytes()).hexdigest()
    if runtime.get("packageLockSha256") != lock_hash:
        fail("release manifest package-lock hash is stale")
    package = json.loads((root / "admin-app/package.json").read_text(encoding="utf-8"))
    if package.get("engines", {}).get("node") != ">=24 <25":
        fail("package engine must stay on Node 24")
    for command in ("register-weekly-cover", "rollback-release"):
        if command not in package.get("scripts", {}):
            fail(f"operator command is missing: {command}")
    for group in ("dependencies", "devDependencies"):
        for name, version in package.get(group, {}).items():
            if not re.fullmatch(r"\d+\.\d+\.\d+", version):
                fail(f"{group} dependency {name} is not exact: {version}")

    config = require_text(
        deploy / "config/oknotika-admin.env.example",
        "OKNOTIKA_ADMIN_ORIGIN=https://admin.oknotika.ru",
        "OKNOTIKA_PUBLIC_ORIGIN=https://oknotika.ru",
        "OKNOTIKA_DATABASE_PATH=/var/lib/oknotika-admin/db/admin.sqlite",
        "OKNOTIKA_UPLOADS_ROOT=/var/lib/oknotika-admin/uploads",
        "OKNOTIKA_PREVIEWS_ROOT=/var/lib/oknotika-admin/previews",
        "OKNOTIKA_ARTICLE_RELEASES_ROOT=/var/lib/oknotika-admin/article-releases",
        "OKNOTIKA_PUBLIC_ROOT=/srv/oknotika/current",
        "OKNOTIKA_LISTEN_SOCKET=/run/oknotika-admin/app.sock",
    )
    if re.search(r"(?:TELEGRAM_OIDC_CLIENT_(?:ID|SECRET)|OKNOTIKA_WEEKLY_INGEST_TOKEN)=", config):
        fail("sample environment must not contain direct credential values")

    require_text(
        deploy / "nginx/oknotika-public.conf",
        "alias /var/lib/oknotika-admin/article-releases/active/articles/",
        "error_page 418 =410",
        "article-releases/active/withdrawn/$article_slug",
        'Cache-Control "public, max-age=0, must-revalidate"',
        'Cache-Control "public, max-age=31536000, immutable"',
    )
    require_text(
        deploy / "nginx/oknotika-admin.conf",
        "server unix:/run/oknotika-admin/app.sock",
        "client_max_body_size 1m",
        "client_max_body_size 10m",
        "location = /api/uploads",
        "limit_conn oknotika_admin_uploads 2",
        "limit_req zone=oknotika_admin_login",
        "proxy_set_header X-Forwarded-Proto https",
        "proxy_set_header X-Forwarded-For $remote_addr",
    )
    require_text(
        deploy / "nginx/snippets/admin-security-headers.conf",
        'Cache-Control "no-store"',
        "Content-Security-Policy",
        "frame-ancestors 'none'",
        "Strict-Transport-Security",
        'X-Content-Type-Options "nosniff"',
    )

    require_text(
        deploy / "systemd/oknotika-admin.service",
        "User=oknotika-admin",
        "Group=www-data",
        "UMask=0027",
        "LoadCredentialEncrypted=telegram-oidc-client-secret",
        "LoadCredentialEncrypted=weekly-ingest-token",
        "NoNewPrivileges=yes",
        "ProtectSystem=strict",
        "CapabilityBoundingSet=",
    )
    require_text(
        deploy / "scripts/preflight.sh",
        'expected_database="$expected_state_root/db/admin.sqlite"',
        'expected_uploads="$expected_state_root/uploads"',
        'expected_previews="$expected_state_root/previews"',
        'expected_article_releases="$expected_state_root/article-releases"',
        'expected_public_root="/srv/oknotika/current"',
        "require_exact OKNOTIKA_ARTICLE_RELEASES_ROOT",
    )
    require_text(
        root / "admin-app/src/http/start.js",
        "chmodSync(config.listenSocket, 0o660)",
        "assertTrustedProxyHeaders",
    )
    editor_handler = (root / "admin-app/src/http/handler.js").read_text(encoding="utf-8")
    if "/api/releases/rollback" in editor_handler:
        fail("operational rollback must not be exposed by the editor HTTP handler")
    require_text(
        root / "admin-app/scripts/register-weekly-cover.js",
        "createUploadStore",
        "Exactly one enabled editor",
        "assetId",
    )
    require_text(
        root / "admin-app/scripts/rollback-release.js",
        "publisher.reconcile()",
        "publisher.rollback",
        "releaseId is invalid",
    )
    require_text(
        root / "admin-app/migrations/005_article_content_kind.sql",
        "content_kind",
        "'weekly_digest'",
        "weekly_ingestion_issues",
    )
    require_text(
        root / "admin-app/migrations/006_futuchat_social_destination.sql",
        "ADD COLUMN futuchat_url",
        "https://youtube.com/@oknotika",
        "https://vk.ru/oknotika",
        "https://t.me/FUTU_CHAT",
    )
    require_text(
        root / "admin-app/migrations/007_pending_social_defaults.sql",
        "pending_social_link_defaults",
        "SELECT singleton, telegram_url, youtube_url, vk_url, futuchat_url",
    )
    require_text(
        root / "admin-app/src/http/start.js",
        "publisher.reconcile()",
        "activatePendingSocialDefaults",
    )
    require_text(
        deploy / "systemd/oknotika-admin-backup.timer",
        "OnCalendar=",
        "Persistent=true",
    )
    require_text(
        deploy / "systemd/oknotika-admin-backup.path",
        "PathChanged=/var/lib/oknotika-admin/article-releases/active",
    )
    require_text(
        deploy / "scripts/backup.sh",
        "run-with-publisher-lock.mjs",
        "reconcile-public-state.mjs",
        "--keep-daily 7",
        "--keep-weekly 8",
        "--keep-monthly 12",
        "uploads",
        "article-releases/releases",
        "backups/online/admin.sqlite",
    )
    require_text(
        deploy / "scripts/pre-migrate-backup.sh",
        "pending-migrations.mjs",
        "maximum_backups=10",
        "sha256sum -c",
    )
    require_text(
        deploy / "scripts/pending-migrations.mjs",
        "new DatabaseSync(databasePath, { readOnly: true })",
        "duplicate migration version",
        "fingerprint.digest('hex')",
    )
    install_marketing = require_text(
        deploy / "scripts/install-marketing.sh",
        "public_paths=(",
        "releases/$release_sha",
        "mv -Tf",
    )
    public_paths = re.search(r"public_paths=\((.*?)\)", install_marketing, re.DOTALL)
    if not public_paths:
        fail("marketing public path allowlist is unreadable")
    for forbidden_path in ("admin-app", "deploy", "docs", "release-evidence", "tests"):
        if re.search(rf"(?:^|\s){re.escape(forbidden_path)}(?:\s|$)", public_paths.group(1)):
            fail(f"technical path leaked into marketing allowlist: {forbidden_path}")

    require_text(
        deploy / "scripts/smoke-weekly-ingestion.mjs",
        "CREDENTIALS_DIRECTORY",
        "/api/ingestion/weekly-drafts",
        "weekly ingestion retry is not idempotent",
        "/api/releases/rollback",
        "editorialCapabilities: 'denied'",
    )
    require_text(
        deploy / "scripts/smoke-test.sh",
        "--weekly-path",
        "https://t.me/oknotika|Telegram",
        "https://youtube.com/@oknotika|YouTube",
        "https://vk.ru/oknotika|VK",
        "https://t.me/FUTU_CHAT|FUTUCHAT",
    )

    scripts = sorted((deploy / "scripts").glob("*.sh"))
    if not scripts:
        fail("no deployment shell scripts found")
    for script_path in scripts:
        result = subprocess.run(["bash", "-n", script_path], capture_output=True, text=True, check=False)
        if result.returncode:
            fail(f"bash syntax error in {script_path}: {result.stderr.strip()}")
        if not stat.S_IMODE(script_path.stat().st_mode) & stat.S_IXUSR:
            fail(f"deployment script is not executable: {script_path}")

    forbidden = re.compile(r"\b(?:DROP\s+(?:TABLE|COLUMN)|ALTER\s+TABLE\s+\S+\s+RENAME)\b", re.IGNORECASE)
    for migration in sorted((root / "admin-app/migrations").glob("*.sql")):
        if forbidden.search(migration.read_text(encoding="utf-8")):
            fail(f"migration is not backward-compatible: {migration.name}")

    require_text(
        deploy / "README_ZHENYA.md",
        "RPO: 24",
        "RTO: 2",
        "Первичное подключение редактора",
        "Emergency disable",
        "Content rollback",
        "Marketing rollback",
        "Application rollback",
        "nginx -t",
        "systemd-analyze verify",
        "npm run bootstrap-editor",
        "--unit=oknotika-bootstrap-content",
        "--property=User=oknotika-admin --property=Group=www-data --property=UMask=0027",
        "run bootstrap-content",
        "install-marketing.sh",
        "Tuesday ingestion и draft-only smoke",
        "smoke-weekly-ingestion.mjs",
        "DNS/TLS",
        "Pinned runtime",
        "Enrollment Сани",
        "Weekly ingestion",
        "run register-weekly-cover",
        "run rollback-release",
        "отсутствует в editor HTTP API",
        "--token-file",
        "database-only состояние не считается применённым",
    )
    print(f"deploy package check passed: {len(scripts)} shell scripts, Node {runtime['nodeVersion']}")


if __name__ == "__main__":
    main()
