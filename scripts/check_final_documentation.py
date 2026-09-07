#!/usr/bin/env python3
"""Validate final documentation and release identification records."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

from scan_release_zip import scan_archive


VERSION = "v2.29.0-rc.2"
HISTORICAL_VERSION = "v2.29.0-rc.1"
BASELINE = "5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed"
STALE_MARKERS = ("V2.18", "V2.25")
DEPLOY_REQUIRED = (
    "## Backup и restore",
    "## Emergency disable",
    "Content rollback",
    "Marketing rollback",
    "Application rollback",
    "## Первичное подключение редактора",
    "## Tuesday ingestion и draft-only smoke",
    "smoke-weekly-ingestion.mjs",
    "Pinned runtime",
    "Enrollment Сани",
    "Restore:",
    "run register-weekly-cover",
    "run rollback-release",
    "--application-schema 3",
    "https://vk.ru/oknotika",
    "https://t.me/FUTU_CHAT",
    "--token-file",
    "database-only состояние не считается применённым",
    "## Активация production CI/CD",
    "required reviewer — Женя",
    "OKNOTIKA_DEPLOY_SSH_PRIVATE_KEY",
    "OKNOTIKA_DEPLOY_SSH_KNOWN_HOSTS",
    "protected `main`",
    "сравнивает SHA-256 обоих установленных root-owned helper",
    "Первый bootstrap, routine deploy и evidence",
    "article/content symlink не меняется",
    "Migration 010 для удаления never-published drafts",
    "schema-9 rollback application",
    "Application rollback не восстанавливает уже удалённый draft",
)
DOCKER_EXTENSION_FILES = {
    ".dockerignore",
    ".gitignore",
    "admin-app/.env.example",
    "admin-app/src/auth/config.js",
    "admin-app/src/http/listener.js",
    "admin-app/src/http/start.js",
    "admin-app/tests/listener.test.js",
    "scripts/build_docker_package.py",
    "scripts/check_deploy_package.py",
    "scripts/check_docker_archive.py",
    "scripts/check_docker_package.py",
    "scripts/check_final_documentation.py",
    "tests/test_docker_archive.py",
    "tests/test_docker_package.py",
    "tests/test_release_package.py",
}
CI_OPERATIONAL_EXTENSION_FILES = {
    ".github/workflows/ci.yml",
    "scripts/check_cicd_package.py",
    "tests/test_cicd_package.py",
}
LOCAL_PASSWORD_AUTH_EXTENSION_FILES = {
    "CLAUDE.md",
    "README.md",
    "admin-app/ENROLLMENT.md",
    "admin-app/migrations/008_local_credentials.sql",
    "admin-app/migrations/009_local_login_csrf.sql",
    "admin-app/scripts/bootstrap-editor.js",
    "admin-app/scripts/configure-local-credentials.js",
    "admin-app/src/auth/credential-setup.js",
    "admin-app/src/auth/local.js",
    "admin-app/src/auth/login.js",
    "admin-app/src/auth/sessions.js",
    "admin-app/src/http/handler.js",
    "admin-app/src/http/node-adapter.js",
    "admin-app/src/http/security.js",
    "admin-app/templates/admin/admin.css",
    "admin-app/templates/admin/login.html",
    "admin-app/tests/auth-security.test.js",
    "admin-app/tests/deploy.test.js",
    "admin-app/tests/http-security.test.js",
    "admin-app/tests/weekly-ingestion-security.test.js",
    "deploy/README_ZHENYA.md",
    "deploy/cicd/oknotika-deploy",
    "deploy/config/oknotika-admin.env.example",
    "deploy/nginx/oknotika-admin.conf",
    "deploy/release-manifest.json",
    "deploy/scripts/preflight.sh",
    "deploy/systemd/oknotika-admin.service",
    "docs/WEEKLY_INGESTION.md",
    "scripts/check_ci_bundle.py",
    "scripts/scan_release_zip.py",
    "tests/test_release_package.py",
}
DRAFT_DELETION_EXTENSION_FILES = {
    "admin-app/migrations/010_never_published_draft_deletion.sql",
    "admin-app/src/content/service.js",
    "admin-app/src/http/admin-actions.js",
    "admin-app/src/http/handler.js",
    "admin-app/src/http/node-adapter.js",
    "admin-app/src/http/start.js",
    "admin-app/src/render/preview.js",
    "admin-app/templates/admin/admin.js",
    "admin-app/tests/admin-client.test.js",
    "admin-app/tests/content.test.js",
    "admin-app/tests/deploy.test.js",
    "admin-app/tests/helpers.js",
    "admin-app/tests/http-security.test.js",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(text: str, path: str, needles: tuple[str, ...], errors: list[str]) -> None:
    for needle in needles:
        if needle not in text:
            errors.append(f"{path} is missing {needle!r}")


def validate_readme_text(text: str) -> list[str]:
    errors = [f"README.md retains stale marker {marker}" for marker in STALE_MARKERS if marker in text]
    require(text, "README.md", (
        "# ОКНОТИКА — production-candidate handoff сайта",
        "## Content model «Новости» / «Дайджест недели»",
        "## Локальный аккаунт и доступ",
        "## Editor flow",
        "## Полная локальная валидация",
        "## Release и эксплуатация",
        "admin-app/ENROLLMENT.md",
        "deploy/README_ZHENYA.md",
        "docs/WEEKLY_INGESTION.md",
        "Tuesday ingestion smoke",
        "https://youtube.com/@oknotika",
        "https://vk.ru/oknotika",
        "https://t.me/FUTU_CHAT",
        "npm run rollback-release",
        "release/CHANGED_FILES-v2.29.0-rc.2.txt",
        "v2.29.0-rc.1` сохранён без изменений как исторический handoff",
        "Архитектурный ADR намеренно не создан",
    ), errors)
    return errors


def validate_public_html_text(text: str, path: str = "index.html") -> list[str]:
    return [f"{path} retains stale marker {marker}" for marker in STALE_MARKERS if marker in text]


def validate_deploy_text(text: str) -> list[str]:
    errors: list[str] = []
    require(text, "deploy/README_ZHENYA.md", DEPLOY_REQUIRED, errors)
    return errors


def parse_checksums(path: Path) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (\S+)", line)
        if not match:
            raise ValueError(f"invalid checksum line: {line!r}")
        checksums[match.group(2)] = match.group(1)
    return checksums


def non_release_changes_since(root: Path, implementation: str) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(root), "diff", "--name-only", "-z", f"{implementation}..HEAD", "--"],
        check=True,
        stdout=subprocess.PIPE,
    )
    return sorted(
        path.decode() for path in result.stdout.split(b"\0")
        if path
        and not path.decode().startswith("release/")
        and not path.decode().startswith("docs/plans/")
    )


def reviewed_docker_extension_path(path: str) -> bool:
    return path.startswith("deploy/docker/") or path in DOCKER_EXTENSION_FILES


def reviewed_post_release_extension_path(path: str) -> bool:
    return (
        reviewed_docker_extension_path(path)
        or path in CI_OPERATIONAL_EXTENSION_FILES
        or path in LOCAL_PASSWORD_AUTH_EXTENSION_FILES
        or path in DRAFT_DELETION_EXTENSION_FILES
    )


def validate(root: Path) -> list[str]:
    errors: list[str] = []
    readme = (root / "README.md").read_text(encoding="utf-8")
    errors.extend(validate_readme_text(readme))
    homepage = (root / "index.html").read_text(encoding="utf-8")
    errors.extend(validate_public_html_text(homepage))
    require(homepage, "index.html", ("ОКНОТИКА ·",), errors)

    image_sources = (root / "IMAGE_SOURCES.md").read_text(encoding="utf-8")
    require(image_sources, "IMAGE_SOURCES.md", (
        "# Источники и права на изображения",
        "Pexels License",
        "release-evidence/team-release-evidence.json",
        "ALUMINUM_SOURCES.md",
        "логотипы Schüco",
    ), errors)
    if "V2.26" in image_sources:
        errors.append("IMAGE_SOURCES.md retains a preview-version marker")

    aluminum_sources = (root / "ALUMINUM_SOURCES.md").read_text(encoding="utf-8")
    require(aluminum_sources, "ALUMINUM_SOURCES.md", (
        "BEGIN ALUMINUM_PROVENANCE_JSON",
        "END ALUMINUM_PROVENANCE_JSON",
        "IMAGE_SOURCES.md",
        '"license_or_use"',
        '"supported_claims"',
    ), errors)

    enrollment = (root / "admin-app/ENROLLMENT.md").read_text(encoding="utf-8")
    require(enrollment, "admin-app/ENROLLMENT.md", (
        "versioned scrypt password",
        "configure-local-credentials.sh",
        "root:1000 0640",
        "SQLite snapshot",
        "credential-rotated",
        "credential-rollback",
        "bearer token не является editor session",
        "https://t.me/FUTU_CHAT",
    ), errors)

    maintenance = (root / "CLAUDE.md").read_text(encoding="utf-8")
    require(maintenance, "CLAUDE.md", (
        "POST /api/ingestion/weekly-drafts",
        "content_kind",
        "npm run rollback-release",
        "docs/WEEKLY_INGESTION.md",
    ), errors)

    deploy = (root / "deploy/README_ZHENYA.md").read_text(encoding="utf-8")
    errors.extend(validate_deploy_text(deploy))

    ingestion = (root / "docs/WEEKLY_INGESTION.md").read_text(encoding="utf-8")
    require(ingestion, "docs/WEEKLY_INGESTION.md", (
        "POST https://admin.oknotika.ru/api/ingestion/weekly-drafts",
        "contentVersion",
        "LoadCredentialEncrypted",
        "## Production smoke",
        "smoke-weekly-ingestion.mjs",
        "Черновик",
        "## Response contract",
        "## Reusable cover provisioning",
        "3–5 top-level editorial",
        "https://youtube.com/@oknotika",
        "https://vk.ru/oknotika",
        "https://t.me/FUTU_CHAT",
        "--token-file",
    ), errors)

    release = root / "release"
    manifest_path = release / f"release-manifest-{VERSION}.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    implementation = manifest.get("implementationCommit", "")
    if manifest.get("version") != VERSION:
        errors.append("release manifest version is wrong")
    if manifest.get("baselineCommit") != BASELINE:
        errors.append("release manifest baseline is wrong")
    if not re.fullmatch(r"[0-9a-f]{40}", implementation):
        errors.append("release manifest implementation SHA is invalid")
    elif subprocess.run(
        ["git", "-C", str(root), "merge-base", "--is-ancestor", implementation, "HEAD"],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode:
        errors.append("release implementation SHA is not an ancestor of HEAD")
    else:
        stale_paths = [
            path
            for path in non_release_changes_since(root, implementation)
            if not reviewed_post_release_extension_path(path)
        ]
        if stale_paths:
            errors.append(
                "release implementation predates non-release source changes: "
                + ", ".join(stale_paths)
            )

    notes = (release / f"RELEASE_NOTES-{VERSION}.md").read_text(encoding="utf-8")
    require(notes, f"RELEASE_NOTES-{VERSION}.md", (
        implementation,
        BASELINE,
        "SHA256SUMS",
        f"CHANGED_FILES-{VERSION}.txt",
        "Tuesday weekly ingestion",
        "weekly-ingestion HTTPS smoke",
        "https://youtube.com/@oknotika",
        "https://vk.ru/oknotika",
        "https://t.me/FUTU_CHAT",
        "protected `main`",
        "GitHub Environment `production`",
        "v2.29.0-rc.1",
    ), errors)

    versioned_name = f"oknotika-final-{VERSION}.zip"
    versioned = release / versioned_name
    stable = release / "oknotika-final.zip"
    try:
        checksums = parse_checksums(release / "SHA256SUMS")
    except ValueError as exc:
        errors.append(str(exc))
        checksums = {}
    versioned_hash = sha256(versioned)
    stable_hash = sha256(stable)
    historical_name = f"oknotika-final-{HISTORICAL_VERSION}.zip"
    historical = release / historical_name
    historical_hash = sha256(historical)
    if checksums != {
        versioned_name: versioned_hash,
        stable.name: stable_hash,
        historical_name: historical_hash,
    }:
        errors.append("SHA256SUMS does not match current, stable and historical release archives")
    if versioned_hash != stable_hash or versioned.read_bytes() != stable.read_bytes():
        errors.append("stable and versioned release archives differ")
    if manifest.get("archiveSha256") != versioned_hash or manifest.get("archiveBytes") != versioned.stat().st_size:
        errors.append("external release manifest archive hash/size is stale")

    scan = scan_archive(str(versioned))
    errors.extend(f"release scan: {error}" for error in scan["errors"])
    if manifest.get("files") != scan["files"] or manifest.get("uncompressedBytes") != scan["uncompressedBytes"]:
        errors.append("external release manifest file/byte counts are stale")

    historical_manifest_path = release / f"release-manifest-{HISTORICAL_VERSION}.json"
    historical_manifest = json.loads(historical_manifest_path.read_text(encoding="utf-8"))
    if historical_manifest.get("version") != HISTORICAL_VERSION:
        errors.append("historical rc.1 manifest version is wrong")
    if historical_manifest.get("archiveSha256") != historical_hash \
            or historical_manifest.get("archiveBytes") != historical.stat().st_size:
        errors.append("historical rc.1 archive no longer matches its manifest")

    inventory_path = release / f"CHANGED_FILES-{VERSION}.txt"
    inventory = inventory_path.read_bytes()
    with zipfile.ZipFile(versioned) as archive:
        embedded_path = f"oknotika-final-{VERSION}/CHANGED_FILES.txt"
        if archive.read(embedded_path) != inventory:
            errors.append("external and embedded changed-file inventories differ")
    inventory_text = inventory.decode("utf-8")
    inventory_entries = [line for line in inventory_text.splitlines() if line[:2] in {"A\t", "M\t"}]
    if manifest.get("changedFiles") != len(inventory_entries):
        errors.append("external release manifest changed-file count is stale")
    require(inventory_text, inventory_path.name, (
        f"# Baseline: {BASELINE}",
        f"# Verified implementation: {implementation}",
        "M\tREADME.md",
        "M\tIMAGE_SOURCES.md",
        "A\tALUMINUM_SOURCES.md",
        "A\tadmin-app/package.json",
        "A\tdeploy/README_ZHENYA.md",
        "A\t.github/workflows/deploy-production.yml",
        "A\tdeploy/cicd/upload-and-deploy.sh",
        "A\tCHANGED_FILES.txt",
        "A\tRELEASE_NOTES.md",
    ), errors)
    return errors


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    try:
        errors = validate(root)
    except (OSError, KeyError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
        errors = [f"unable to validate final documentation: {exc}"]
    if errors:
        print("final documentation check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"final documentation check passed: {VERSION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
