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

    lock_path = root / "admin-app/package-lock.json"
    lock_hash = hashlib.sha256(lock_path.read_bytes()).hexdigest()
    if runtime.get("packageLockSha256") != lock_hash:
        fail("release manifest package-lock hash is stale")
    package = json.loads((root / "admin-app/package.json").read_text(encoding="utf-8"))
    if package.get("engines", {}).get("node") != ">=24 <25":
        fail("package engine must stay on Node 24")
    for group in ("dependencies", "devDependencies"):
        for name, version in package.get(group, {}).items():
            if not re.fullmatch(r"\d+\.\d+\.\d+", version):
                fail(f"{group} dependency {name} is not exact: {version}")

    config = require_text(
        deploy / "config/oknotika-admin.env.example",
        "OKNOTIKA_ADMIN_ORIGIN=https://admin.oknotika.ru",
        "OKNOTIKA_PUBLIC_ORIGIN=https://oknotika.ru",
        "OKNOTIKA_DATABASE_PATH=/var/lib/oknotika-admin/db/admin.sqlite",
        "OKNOTIKA_LISTEN_SOCKET=/run/oknotika-admin/app.sock",
    )
    if re.search(r"TELEGRAM_OIDC_CLIENT_(?:ID|SECRET)=", config):
        fail("sample environment must not contain direct OIDC credential values")

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
        "client_max_body_size 10m",
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
        "NoNewPrivileges=yes",
        "ProtectSystem=strict",
        "CapabilityBoundingSet=",
    )
    require_text(
        root / "admin-app/src/http/start.js",
        "chmodSync(config.listenSocket, 0o660)",
        "assertTrustedProxyHeaders",
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
        "--keep-daily 7",
        "--keep-weekly 8",
        "--keep-monthly 12",
        "uploads",
        "article-releases/releases",
        "backups/online/admin.sqlite",
    )
    require_text(
        deploy / "scripts/install-marketing.sh",
        "public_paths=(",
        "releases/$release_sha",
        "mv -Tf",
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
        "run bootstrap-content",
        "install-marketing.sh",
    )
    print(f"deploy package check passed: {len(scripts)} shell scripts, Node {runtime['nodeVersion']}")


if __name__ == "__main__":
    main()
