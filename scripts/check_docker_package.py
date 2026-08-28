#!/usr/bin/env python3
"""Validate the secret-free Docker Compose deployment topology."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


ADMIN_IMAGE = "oknotika-admin:v2.29.0-rc.4"
PUBLIC_IMAGE = "oknotika-public:v2.29.0-rc.4"
HOST_ROOT = "/var/home/oknotika"
ADMIN_DATA_ROOT = f"{HOST_ROOT}/admin-app/data"
SECRETS = {
    "telegram_oidc_client_id",
    "telegram_oidc_client_secret",
    "weekly_ingest_token",
}
REJECTED_ADMIN_DOMAIN = "admin." + "okntoika.ru"
STANDALONE_INSTRUCTION = "release/oknotika-docker-v2.29.0-rc.4-instruction.html"
SECRET_EXAMPLE_PLACEHOLDERS = {
    "telegram-oidc-client-id": "replace-on-deployment-host\n",
    "telegram-oidc-client-secret": "replace-on-deployment-host\n",
    "weekly-ingest-token": "replace-on-deployment-host-with-at-least-32-random-characters\n",
}


def read_required(root: Path, relative: str, errors: list[str]) -> str:
    path = root / relative
    if not path.is_file():
        errors.append(f"missing {relative}")
        return ""
    return path.read_text(encoding="utf-8")


def require_markers(text: str, relative: str, markers: tuple[str, ...], errors: list[str]) -> None:
    for marker in markers:
        if marker not in text:
            errors.append(f"{relative} does not contain {marker!r}")


def validate_secret_example_text(text: str, relative: str, expected: str) -> list[str]:
    if text == expected:
        return []
    return [f"{relative} must contain only the invalid deployment placeholder"]


def validate_compose_text(text: str) -> list[str]:
    errors: list[str] = []
    direct_secret = re.compile(
        r"^\s+(?:TELEGRAM_OIDC_CLIENT_ID|TELEGRAM_OIDC_CLIENT_SECRET|OKNOTIKA_WEEKLY_INGEST_TOKEN):",
        re.MULTILINE,
    )
    if direct_secret.search(text):
        errors.append("Compose environment contains a direct credential value")
    require_markers(
        text,
        "deploy/docker/docker-compose.yml",
        (
            '"127.0.0.1:${OKNOTIKA_ADMIN_PORT:-8000}:8000"',
            '"127.0.0.1:${OKNOTIKA_PUBLIC_PORT:-8001}:8001"',
            "TELEGRAM_OIDC_CLIENT_ID_FILE: /run/secrets/telegram_oidc_client_id",
            "TELEGRAM_OIDC_CLIENT_SECRET_FILE: /run/secrets/telegram_oidc_client_secret",
            "OKNOTIKA_WEEKLY_INGEST_TOKEN_FILE: /run/secrets/weekly_ingest_token",
            "context: ${OKNOTIKA_BUILD_ROOT:-../..}",
            "source: ${OKNOTIKA_HOST_ROOT:-/var/home/oknotika}/admin-app/data/db",
            "source: ${OKNOTIKA_HOST_ROOT:-/var/home/oknotika}/admin-app/data/article-releases",
            "target: /var/home/oknotika/admin-app/data/article-releases",
            "create_host_path: false",
        ),
        errors,
    )
    if re.search(r"^volumes:\s*$", text, re.MULTILINE):
        errors.append("Compose must not define named volumes")
    if "/var/lib/oknotika-admin" in text:
        errors.append("Compose contains the retired container data root")
    return errors


def validate_host_nginx_text(text: str) -> list[str]:
    errors: list[str] = []
    require_markers(
        text,
        "deploy/docker/host-nginx.conf",
        (
            "limit_req_zone $binary_remote_addr zone=oknotika_docker_admin_general:10m rate=60r/m;",
            "limit_req_zone $binary_remote_addr zone=oknotika_docker_admin_login:10m rate=5r/m;",
            "limit_conn_zone $server_name zone=oknotika_docker_admin_uploads:10m;",
            "upstream oknotika_docker_admin {\n    server 127.0.0.1:8000;",
            "upstream oknotika_docker_public {\n    server 127.0.0.1:8001;",
            "server_name admin.oknotika.ru;\n    return 308 https://admin.oknotika.ru$request_uri;",
            "server_name oknotika.ru www.oknotika.ru;\n    return 308 https://oknotika.ru$request_uri;",
            "server_name www.oknotika.ru;",
            "ssl_certificate /etc/letsencrypt/live/admin.oknotika.ru/fullchain.pem;",
            "ssl_certificate /etc/letsencrypt/live/oknotika.ru/fullchain.pem;",
            "proxy_pass http://oknotika_docker_admin;",
            "proxy_pass http://oknotika_docker_public;",
            "client_max_body_size 1m;",
            "client_max_body_size 10m;",
            "location = /auth/callback {",
            "location = /api/uploads {",
            "limit_req zone=oknotika_docker_admin_login burst=3 nodelay;",
            "limit_conn oknotika_docker_admin_uploads 2;",
            "proxy_set_header Host admin.oknotika.ru;",
            "proxy_set_header X-Forwarded-Host admin.oknotika.ru;",
            "proxy_set_header X-Forwarded-Proto https;",
            "proxy_set_header X-Forwarded-For $remote_addr;",
        ),
        errors,
    )
    if REJECTED_ADMIN_DOMAIN in text:
        errors.append("host nginx contains the rejected typo admin domain")
    for public_listener in (
        "server 0.0.0.0:8000",
        "server 0.0.0.0:8001",
        "server [::]:8000",
        "server [::]:8001",
    ):
        if public_listener in text:
            errors.append(f"host nginx uses a public backend upstream: {public_listener}")
    if "$proxy_add_x_forwarded_for" in text:
        errors.append("host nginx must replace, not append, X-Forwarded-For")
    if text.count("proxy_set_header X-Forwarded-For $remote_addr;") < 5:
        errors.append("host nginx does not replace X-Forwarded-For in every proxy location")
    callback = re.search(r"location = /auth/callback \{(?P<body>.*?)\n    \}", text, re.DOTALL)
    if callback is not None:
        callback_body = callback.group("body")
        if "access_log off;" not in callback_body:
            errors.append("host nginx callback access logging must be disabled")
        if "error_log /dev/null crit;" not in callback_body:
            errors.append("host nginx callback error logging must be suppressed")
    return errors


def validate_docker_runbook_text(text: str) -> list[str]:
    errors: list[str] = []
    require_markers(
        text,
        "deploy/docker/README_ZHENYA.md",
        (
            "DNS A/AAAA",
            "/etc/letsencrypt/live/oknotika.ru/{fullchain,privkey}.pem",
            "/etc/letsencrypt/live/admin.oknotika.ru/{fullchain,privkey}.pem",
            "https://admin.oknotika.ru/auth/callback",
            "sudo unzip -q oknotika-docker-v2.29.0-rc.4.zip -d \"$OKNOTIKA_ROOT\"",
            "export OKNOTIKA_RELEASE=v2.29.0-rc.4",
            "set -euo pipefail",
            "export OKNOTIKA_ROOT=/var/home/oknotika",
            "/var/home/oknotika/admin-app/data/",
            "/var/home/oknotika/public-app/data/",
            "create_host_path=false",
            "for name in telegram-oidc-client-id telegram-oidc-client-secret; do",
            'export OKNOTIKA_SECRETS_ROOT="$OKNOTIKA_ROOT/admin-app/data/secrets"',
            'sudo chown root:1000 "$OKNOTIKA_SECRETS_ROOT"/*',
            'sudo chmod 0640 "$OKNOTIKA_SECRETS_ROOT"/*',
            "export OKNOTIKA_ACTIVE_PROJECT=oknotika",
            '--project-name "$OKNOTIKA_ACTIVE_PROJECT"',
            'up --detach --no-build --wait --wait-timeout 120',
            "logs --no-color --tail 100 admin public",
            "npm run bootstrap-editor",
            "npm run bootstrap-content",
            "admin npm run register-weekly-cover --",
            "admin node /run/smoke-weekly-ingestion.mjs",
            "--token-file /run/secrets/weekly_ingest_token",
            "admin-data.tar",
            "restart_after_backup() {",
            "trap restart_after_backup EXIT",
            "trap - EXIT",
            "export OKNOTIKA_BACKUP_DIR=/var/backups/oknotika/YYYYMMDD-HHMMSS",
            "Isolated restore drill",
            "OKNOTIKA_ADMIN_PORT=18000",
            "rollback_failed_restore() {",
            "data.before-restore",
            "OKNOTIKA_HOST_ROOT=/var/home/oknotika",
            "rollback_failed_upgrade() {",
            'OKNOTIKA_PREVIOUS_ROOT="/var/home/oknotika-before-$OKNOTIKA_NEW_RELEASE"',
            "stop admin",
            "docker compose down -v ЗАПРЕЩЕНА",
            "0.0.0.0:8000, 0.0.0.0:8001",
            "Запрещено встраивать credentials",
            "Единственный runtime mount public — article-releases read-only",
        ),
        errors,
    )
    if REJECTED_ADMIN_DOMAIN in text:
        errors.append("Docker runbook contains the rejected typo admin domain")
    direct_secret = re.compile(
        r"^\s*(?:TELEGRAM_OIDC_CLIENT_ID|TELEGRAM_OIDC_CLIENT_SECRET|OKNOTIKA_WEEKLY_INGEST_TOKEN)\s*=\s*\S+",
        re.MULTILINE,
    )
    if direct_secret.search(text):
        errors.append("Docker runbook embeds a credential in an environment assignment")
    if "--project-name oknotika" in text:
        errors.append("Docker runbook hardcodes the original Compose project name")
    for forbidden_checksum in ("sha256sum", "SHA256SUMS", ".zip.sha256", "OKNOTIKA_ARCHIVE_SHA"):
        if forbidden_checksum in text:
            errors.append(f"Docker runbook contains a user-facing checksum step: {forbidden_checksum}")
    if text.count("set -euo pipefail") < 6:
        errors.append("Docker runbook integrity-sensitive command blocks are not fail-fast")
    for retired in ("/var/lib/oknotika-admin", "/opt/oknotika-docker", "/etc/oknotika/secrets"):
        if retired in text:
            errors.append(f"Docker runbook contains retired path: {retired}")
    return errors


def validate_standalone_instruction_text(text: str) -> list[str]:
    errors: list[str] = []
    require_markers(
        text,
        STANDALONE_INSTRUCTION,
        (
            '<html lang="ru">',
            "oknotika-docker-v2.29.0-rc.4.zip",
            "/var/home/oknotika/admin-app/data/",
            "/var/home/oknotika/public-app/data/",
            "admin-app deploy public-app ",
            "export OKNOTIKA_RELEASE=v2.29.0-rc.4",
            "127.0.0.1:8000",
            "127.0.0.1:8001",
            "article-releases</code> read-only",
        ),
        errors,
    )
    if re.search(r"\b(?:src|href)\s*=", text, re.IGNORECASE):
        errors.append("standalone Docker instruction must not depend on external resources")
    for forbidden_checksum in ("sha256sum", "SHA256SUMS", ".zip.sha256", "OKNOTIKA_ARCHIVE_SHA"):
        if forbidden_checksum in text:
            errors.append(
                f"standalone Docker instruction contains a user-facing checksum step: {forbidden_checksum}"
            )
    return errors


def compose_model(root: Path) -> dict[str, Any]:
    environment = {
        **os.environ,
        "OKNOTIKA_ADMIN_IMAGE": ADMIN_IMAGE,
        "OKNOTIKA_PUBLIC_IMAGE": PUBLIC_IMAGE,
    }
    result = subprocess.run(
        [
            "docker", "compose",
            "--file", str(root / "deploy/docker/docker-compose.yml"),
            "--env-file", str(root / "deploy/docker/compose.env.example"),
            "config", "--format", "json",
        ],
        cwd=root,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "docker compose config failed")
    return json.loads(result.stdout)


def validate_compose_model(model: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    services = model.get("services", {})
    if set(services) != {"admin", "public"}:
        return ["Compose must define exactly admin and public services"]
    if model.get("volumes"):
        errors.append("Compose must not define named volumes")
    if set(model.get("secrets", {})) != SECRETS:
        errors.append("Compose secret set is not exact")
    expected_secret_files = {
        "telegram_oidc_client_id": f"{ADMIN_DATA_ROOT}/secrets/telegram-oidc-client-id",
        "telegram_oidc_client_secret": f"{ADMIN_DATA_ROOT}/secrets/telegram-oidc-client-secret",
        "weekly_ingest_token": f"{ADMIN_DATA_ROOT}/secrets/weekly-ingest-token",
    }
    for name, expected in expected_secret_files.items():
        if model.get("secrets", {}).get(name, {}).get("file") != expected:
            errors.append(f"Compose secret source is not exact: {name}")

    expected_ports = {
        "admin": ("127.0.0.1", "8000", 8000),
        "public": ("127.0.0.1", "8001", 8001),
    }
    expected_images = {"admin": ADMIN_IMAGE, "public": PUBLIC_IMAGE}
    expected_users = {"admin": "1000:1000", "public": "101:1000"}
    for name, service in services.items():
        ports = service.get("ports", [])
        if len(ports) != 1:
            errors.append(f"{name} must publish exactly one port")
        else:
            port = ports[0]
            actual = (port.get("host_ip"), str(port.get("published")), port.get("target"))
            if actual != expected_ports[name]:
                errors.append(f"{name} port binding is not exact: {actual}")
        if service.get("image") != expected_images[name]:
            errors.append(f"{name} image tag is not the reviewed default")
        if service.get("user") != expected_users[name]:
            errors.append(f"{name} user is not the pinned non-root UID/GID")
        if service.get("read_only") is not True:
            errors.append(f"{name} root filesystem must be read-only")
        if service.get("restart") != "unless-stopped":
            errors.append(f"{name} restart policy is missing")
        if "ALL" not in service.get("cap_drop", []):
            errors.append(f"{name} must drop all Linux capabilities")
        if "no-new-privileges:true" not in service.get("security_opt", []):
            errors.append(f"{name} must enable no-new-privileges")
        tmpfs = " ".join(service.get("tmpfs", []))
        if "/tmp:" not in tmpfs or "noexec" not in tmpfs or "nosuid" not in tmpfs or "nodev" not in tmpfs:
            errors.append(f"{name} hardened tmpfs is missing")
        if not service.get("healthcheck", {}).get("test"):
            errors.append(f"{name} healthcheck is missing")
        if not service.get("mem_limit") or not service.get("cpus") or not service.get("pids_limit"):
            errors.append(f"{name} resource limits are incomplete")

    admin = services["admin"]
    admin_volumes = {
        (
            volume.get("type"),
            volume.get("source"),
            volume.get("target"),
            bool(volume.get("read_only")),
            volume.get("bind", {}).get("create_host_path"),
        )
        for volume in admin.get("volumes", [])
    }
    expected_admin_volumes = {
        ("bind", f"{ADMIN_DATA_ROOT}/db", f"{ADMIN_DATA_ROOT}/db", False, False),
        ("bind", f"{ADMIN_DATA_ROOT}/uploads", f"{ADMIN_DATA_ROOT}/uploads", False, False),
        ("bind", f"{ADMIN_DATA_ROOT}/previews", f"{ADMIN_DATA_ROOT}/previews", False, False),
        ("bind", f"{ADMIN_DATA_ROOT}/backups", f"{ADMIN_DATA_ROOT}/backups", False, False),
        (
            "bind",
            f"{ADMIN_DATA_ROOT}/article-releases",
            f"{ADMIN_DATA_ROOT}/article-releases",
            False,
            False,
        ),
    }
    if admin_volumes != expected_admin_volumes:
        errors.append("admin persistent bind mappings are not exact")
    admin_secrets = {secret.get("source") for secret in admin.get("secrets", [])}
    if admin_secrets != SECRETS:
        errors.append("admin must mount exactly the three file secrets")
    environment = admin.get("environment", {})
    expected_environment = {
        "OKNOTIKA_ADMIN_ORIGIN": "https://admin.oknotika.ru",
        "OKNOTIKA_PUBLIC_ORIGIN": "https://oknotika.ru",
        "TELEGRAM_OIDC_REDIRECT_URI": "https://admin.oknotika.ru/auth/callback",
        "OKNOTIKA_DATABASE_PATH": f"{ADMIN_DATA_ROOT}/db/admin.sqlite",
        "OKNOTIKA_UPLOADS_ROOT": f"{ADMIN_DATA_ROOT}/uploads",
        "OKNOTIKA_PREVIEWS_ROOT": f"{ADMIN_DATA_ROOT}/previews",
        "OKNOTIKA_ARTICLE_RELEASES_ROOT": f"{ADMIN_DATA_ROOT}/article-releases",
        "OKNOTIKA_PUBLIC_ROOT": f"{HOST_ROOT}/public-app",
        "OKNOTIKA_LISTEN_HOST": "0.0.0.0",
        "OKNOTIKA_LISTEN_PORT": "8000",
    }
    for name, expected in expected_environment.items():
        if environment.get(name) != expected:
            errors.append(f"admin environment {name} is not exact")
    for forbidden in (
        "TELEGRAM_OIDC_CLIENT_ID",
        "TELEGRAM_OIDC_CLIENT_SECRET",
        "OKNOTIKA_WEEKLY_INGEST_TOKEN",
        "OKNOTIKA_LISTEN_SOCKET",
    ):
        if forbidden in environment:
            errors.append(f"admin environment must not set {forbidden}")

    public_volumes = services["public"].get("volumes", [])
    if len(public_volumes) != 1 or (
        public_volumes[0].get("type"),
        public_volumes[0].get("source"),
        public_volumes[0].get("target"),
        public_volumes[0].get("read_only"),
        public_volumes[0].get("bind", {}).get("create_host_path"),
    ) != (
        "bind",
        f"{ADMIN_DATA_ROOT}/article-releases",
        f"{ADMIN_DATA_ROOT}/article-releases",
        True,
        False,
    ):
        errors.append("public must mount only article_releases read-only")
    if services["public"].get("secrets"):
        errors.append("public must not mount secrets")
    return errors


def validate(root: Path) -> list[str]:
    errors: list[str] = []
    compose = read_required(root, "deploy/docker/docker-compose.yml", errors)
    errors.extend(validate_compose_text(compose))

    admin_dockerfile = read_required(root, "deploy/docker/admin.Dockerfile", errors)
    require_markers(
        admin_dockerfile,
        "deploy/docker/admin.Dockerfile",
        (
            "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
            "npm ci --omit=dev",
            "WORKDIR /var/home/oknotika/admin-app",
            "COPY --chown=node:node public-app/style.css /var/home/oknotika/style.css",
            "COPY --chown=node:node public-app/img/logo-oknotika.svg /var/home/oknotika/img/logo-oknotika.svg",
            "USER node:node",
            'ENTRYPOINT ["/usr/local/bin/oknotika-admin-entrypoint"]',
        ),
        errors,
    )
    public_dockerfile = read_required(root, "deploy/docker/public.Dockerfile", errors)
    require_markers(
        public_dockerfile,
        "deploy/docker/public.Dockerfile",
        (
            "nginx:1.29.1-alpine@sha256:42a516af16b852e33b7682d5ef8acbd5d13fe08fecadc7ed98605ba5e3b26ab8",
            "COPY public-app/articles /var/home/oknotika/public-app/articles",
            "/var/home/oknotika/admin-app/data/article-releases",
            "USER 101:1000",
            'ENTRYPOINT ["nginx", "-g", "daemon off;"]',
        ),
        errors,
    )
    entrypoint = read_required(root, "deploy/docker/admin-entrypoint.sh", errors)
    require_markers(
        entrypoint,
        "deploy/docker/admin-entrypoint.sh",
        (
            "umask 0027",
            "data_root=/var/home/oknotika/admin-app/data",
            'prepare_private_directory "$data_root/db"',
            'prepare_shared_directory "$data_root/article-releases/releases"',
            'exec "$@"',
        ),
        errors,
    )
    nginx = read_required(root, "deploy/docker/public-nginx.conf", errors)
    require_markers(
        nginx,
        "deploy/docker/public-nginx.conf",
        (
            "listen 8001;",
            "root /var/home/oknotika/public-app;",
            "root /var/home/oknotika/admin-app/data/article-releases/active;",
            "article-releases/active/withdrawn/$article_slug",
            "try_files $uri/index.html @bundled_article_page;",
        ),
        errors,
    )
    for private_path in ("admin.sqlite", "/uploads", "/previews", "/backups"):
        if private_path in nginx:
            errors.append(f"public nginx exposes a private path marker: {private_path}")

    host_nginx = read_required(root, "deploy/docker/host-nginx.conf", errors)
    errors.extend(validate_host_nginx_text(host_nginx))
    runbook = read_required(root, "deploy/docker/README_ZHENYA.md", errors)
    errors.extend(validate_docker_runbook_text(runbook))
    standalone_instruction = read_required(root, STANDALONE_INSTRUCTION, errors)
    errors.extend(validate_standalone_instruction_text(standalone_instruction))

    dockerignore = read_required(root, ".dockerignore", errors)
    require_markers(
        dockerignore,
        ".dockerignore",
        (
            ".git",
            "admin-app/node_modules",
            "admin-app/var",
            "admin-app/data",
            "public-app/data",
            "deploy/docker/secrets/*",
            "release-evidence",
            "var",
        ),
        errors,
    )
    for name in ("admin.Dockerfile.dockerignore", "public.Dockerfile.dockerignore"):
        scoped_ignore = read_required(root, f"deploy/docker/{name}", errors)
        require_markers(
            scoped_ignore,
            f"deploy/docker/{name}",
            ("**/data", "**/node_modules"),
            errors,
        )
    gitignore = read_required(root, ".gitignore", errors)
    require_markers(
        gitignore,
        ".gitignore",
        ("admin-app/data/", "public-app/data/", "deploy/docker/secrets/*"),
        errors,
    )
    read_required(root, "deploy/docker/compose.env.example", errors)
    read_required(root, "deploy/docker/README.md", errors)
    secrets_readme = read_required(root, "deploy/docker/secrets/README.md", errors)
    require_markers(
        secrets_readme,
        "deploy/docker/secrets/README.md",
        ("`root:1000`", "`0640`", "`1000:1000`"),
        errors,
    )
    smoke_test = read_required(root, "deploy/docker/smoke-test.sh", errors)
    require_markers(
        smoke_test,
        "deploy/docker/smoke-test.sh",
        (
            "test -r /var/home/oknotika/style.css",
            "test -r /var/home/oknotika/img/logo-oknotika.svg",
            'export OKNOTIKA_BUILD_ROOT="$build_root"',
            'export OKNOTIKA_HOST_ROOT="$host_root"',
            "bind-mounted marker did not survive container recreation",
            "public-write",
        ),
        errors,
    )
    for name in (
        "telegram-oidc-client-id",
        "telegram-oidc-client-secret",
        "weekly-ingest-token",
    ):
        if (root / "deploy/docker/secrets" / name).exists():
            errors.append(f"tracked/runtime secret path exists: deploy/docker/secrets/{name}")
        relative = f"deploy/docker/secrets/{name}.example"
        example = read_required(root, relative, errors)
        errors.extend(validate_secret_example_text(
            example,
            relative,
            SECRET_EXAMPLE_PLACEHOLDERS[name],
        ))
    return errors


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    errors = validate(root)
    if shutil.which("docker") is None:
        errors.append("docker compose is required to validate resolved topology")
    else:
        try:
            errors.extend(validate_compose_model(compose_model(root)))
        except (RuntimeError, json.JSONDecodeError) as error:
            errors.append(f"resolved Compose validation failed: {error}")
    if errors:
        for error in errors:
            print(f"docker package check failed: {error}", file=sys.stderr)
        return 1
    print(
        "docker package check passed: two hardened services, exact bind mounts, "
        "three file secrets, host nginx and operations runbook"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
