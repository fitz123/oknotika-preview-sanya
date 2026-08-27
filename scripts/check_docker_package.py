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


ADMIN_IMAGE = "oknotika-admin:v2.29.0-rc.3"
PUBLIC_IMAGE = "oknotika-public:v2.29.0-rc.3"
VOLUMES = {
    "admin_database",
    "admin_uploads",
    "admin_previews",
    "admin_backups",
    "article_releases",
}
SECRETS = {
    "telegram_oidc_client_id",
    "telegram_oidc_client_secret",
    "weekly_ingest_token",
}
REJECTED_ADMIN_DOMAIN = "admin." + "okntoika.ru"


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
            "article_releases:/srv/oknotika/article-releases:ro",
        ),
        errors,
    )
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
    return errors


def validate_docker_runbook_text(text: str) -> list[str]:
    errors: list[str] = []
    require_markers(
        text,
        "deploy/docker/README_ZHENYA.md",
        (
            "DNS `A`/`AAAA`",
            "/etc/letsencrypt/live/oknotika.ru/{fullchain,privkey}.pem",
            "/etc/letsencrypt/live/admin.oknotika.ru/{fullchain,privkey}.pem",
            "https://admin.oknotika.ru/auth/callback",
            "sha256sum --check oknotika-docker-v2.29.0-rc.3.zip.sha256",
            'OKNOTIKA_SECRETS_DIR=/etc/oknotika/secrets',
            "/etc/oknotika/secrets/telegram-oidc-client-id",
            "/etc/oknotika/secrets/telegram-oidc-client-secret",
            "/etc/oknotika/secrets/weekly-ingest-token",
            "sudo chmod 0600 /etc/oknotika/secrets/*",
            'up --detach --no-build --wait --wait-timeout 120',
            "logs --no-color --tail 100 admin public",
            "npm run bootstrap-editor",
            "npm run bootstrap-content",
            "npm run register-weekly-cover",
            "smoke-weekly-ingestion.mjs",
            "admin_database.tar",
            "admin_uploads.tar",
            "admin_previews.tar",
            "admin_backups.tar",
            "article_releases.tar",
            "sha256sum *.tar > SHA256SUMS",
            "OKNOTIKA_RESTORE_PROJECT",
            "Restore всегда делать в новый Compose project",
            "OLD_OKNOTIKA_RELEASE_ROOT",
            "OLD_OKNOTIKA_COMPOSE_ENV",
            "stop admin",
            "`docker compose down -v` ЗАПРЕЩЕНА",
            "`0.0.0.0:8000`, `0.0.0.0:8001`",
            "Запрещено встраивать credentials",
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
    if set(model.get("volumes", {})) != VOLUMES:
        errors.append("Compose named-volume set is not exact")
    if set(model.get("secrets", {})) != SECRETS:
        errors.append("Compose secret set is not exact")

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
        (volume.get("source"), volume.get("target"), bool(volume.get("read_only")))
        for volume in admin.get("volumes", [])
    }
    expected_admin_volumes = {
        ("admin_database", "/var/lib/oknotika-admin/db", False),
        ("admin_uploads", "/var/lib/oknotika-admin/uploads", False),
        ("admin_previews", "/var/lib/oknotika-admin/previews", False),
        ("admin_backups", "/var/lib/oknotika-admin/backups", False),
        ("article_releases", "/var/lib/oknotika-admin/article-releases", False),
    }
    if admin_volumes != expected_admin_volumes:
        errors.append("admin persistent-volume mappings are not exact")
    admin_secrets = {secret.get("source") for secret in admin.get("secrets", [])}
    if admin_secrets != SECRETS:
        errors.append("admin must mount exactly the three file secrets")
    environment = admin.get("environment", {})
    expected_environment = {
        "OKNOTIKA_ADMIN_ORIGIN": "https://admin.oknotika.ru",
        "OKNOTIKA_PUBLIC_ORIGIN": "https://oknotika.ru",
        "TELEGRAM_OIDC_REDIRECT_URI": "https://admin.oknotika.ru/auth/callback",
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
        public_volumes[0].get("source"),
        public_volumes[0].get("target"),
        public_volumes[0].get("read_only"),
    ) != ("article_releases", "/srv/oknotika/article-releases", True):
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
            "COPY articles /srv/oknotika/public/articles",
            "RUN install -d -o 1000 -g 1000 -m 0750 /srv/oknotika/article-releases",
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
            "prepare_private_directory /var/lib/oknotika-admin/db",
            "prepare_shared_directory /var/lib/oknotika-admin/article-releases/releases",
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
            "root /srv/oknotika/public;",
            "root /srv/oknotika/article-releases/active;",
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

    dockerignore = read_required(root, ".dockerignore", errors)
    require_markers(
        dockerignore,
        ".dockerignore",
        (".git", "admin-app/node_modules", "admin-app/var", "deploy/docker/secrets/*", "release-evidence", "var"),
        errors,
    )
    gitignore = read_required(root, ".gitignore", errors)
    require_markers(gitignore, ".gitignore", ("deploy/docker/secrets/*",), errors)
    read_required(root, "deploy/docker/compose.env.example", errors)
    read_required(root, "deploy/docker/README.md", errors)
    read_required(root, "deploy/docker/secrets/README.md", errors)
    read_required(root, "deploy/docker/smoke-test.sh", errors)
    for name in (
        "telegram-oidc-client-id",
        "telegram-oidc-client-secret",
        "weekly-ingest-token",
    ):
        if (root / "deploy/docker/secrets" / name).exists():
            errors.append(f"tracked/runtime secret path exists: deploy/docker/secrets/{name}")
        example = read_required(root, f"deploy/docker/secrets/{name}.example", errors)
        if not example.startswith("replace-on-deployment-host"):
            errors.append(f"secret example is not an invalid placeholder: {name}.example")
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
        "docker package check passed: two hardened services, five volumes, "
        "three file secrets, host nginx and operations runbook"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
