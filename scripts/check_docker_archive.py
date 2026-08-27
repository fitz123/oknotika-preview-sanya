#!/usr/bin/env python3
"""Validate the immutable, secret-free OKNOTIKA Docker handoff archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


PACKAGE_FORMAT = "oknotika-docker-package"
PACKAGE_VERSION = "v2.29.0-rc.3"
PAYLOAD_ROOT = f"oknotika-docker-{PACKAGE_VERSION}"
MANIFEST_NAME = "DOCKER_PACKAGE_MANIFEST.json"
COMMIT_RE = re.compile(r"^[a-f0-9]{40}(?:[a-f0-9]{24})?$")
PUBLIC_FILES = {"index.html", "script.js", "style.css"}
PUBLIC_DIRECTORIES = {
    "aluminum",
    "articles",
    "carbon-glass",
    "glass",
    "img",
    "js",
    "oknotika-smart-window",
    "protectapeel",
    "pvc",
    "wood-stoller",
}
DEPLOY_SUPPORT_FILES = {
    "deploy/nginx/snippets/public-security-headers.conf",
}
REQUIRED_FILES = {
    "index.html",
    "script.js",
    "style.css",
    "js/latest-fact.js",
    "img/logo-oknotika.svg",
    "articles/index.html",
    "articles/latest.json",
    "admin-app/.env.example",
    "admin-app/package.json",
    "admin-app/package-lock.json",
    "admin-app/src/http/listener.js",
    "admin-app/src/http/start.js",
    "deploy/docker/README.md",
    "deploy/docker/README_ZHENYA.md",
    "deploy/docker/admin-entrypoint.sh",
    "deploy/docker/admin.Dockerfile",
    "deploy/docker/compose.env.example",
    "deploy/docker/docker-compose.yml",
    "deploy/docker/host-nginx.conf",
    "deploy/docker/public-nginx.conf",
    "deploy/docker/public.Dockerfile",
    "deploy/docker/secrets/README.md",
    "deploy/docker/secrets/telegram-oidc-client-id.example",
    "deploy/docker/secrets/telegram-oidc-client-secret.example",
    "deploy/docker/secrets/weekly-ingest-token.example",
    "deploy/docker/smoke-test.sh",
    *DEPLOY_SUPPORT_FILES,
}
FORBIDDEN_COMPONENTS = {
    ".git",
    ".ralphex",
    ".tmp-inputs",
    "__pycache__",
    "node_modules",
    "uploads",
    "previews",
    "backups",
    "article-releases",
    "release",
    "release-evidence",
    "var",
}
FORBIDDEN_CREDENTIAL_FILENAMES = {
    "telegram-oidc-client-id",
    "telegram-oidc-client-secret",
    "weekly-ingest-token",
    "restic-repository",
    "restic-password",
}
FORBIDDEN_SUFFIXES = (
    ".sqlite",
    ".sqlite-wal",
    ".sqlite-shm",
    ".log",
    ".pem",
    ".key",
    ".cred",
    ".credential",
    ".zip",
)
SECRET_PATTERNS = {
    "private key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "Telegram bot token": re.compile(
        rb"(?<![A-Za-z0-9])\d{8,12}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9])"
    ),
    "GitHub token": re.compile(rb"\bgh[ps]_[A-Za-z0-9]{30,}\b"),
    "AWS access key": re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    "assigned OIDC secret": re.compile(
        rb"TELEGRAM_OIDC_CLIENT_SECRET\s*=\s*[^\s<#${][^\r\n]*"
    ),
    "assigned weekly ingestion token": re.compile(
        rb"OKNOTIKA_WEEKLY_INGEST_TOKEN\s*=\s*[^\s<#${][^\r\n]*"
    ),
    "assigned restic password": re.compile(rb"RESTIC_PASSWORD\s*=\s*[^\s<#${][^\r\n]*"),
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalized_entry(name: str) -> PurePosixPath | None:
    if not name or "\\" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        return None
    path = PurePosixPath(name)
    if path.as_posix() != name or any(part in {"", ".", ".."} for part in path.parts):
        return None
    return path


def source_path_allowed(path: PurePosixPath) -> bool:
    if len(path.parts) == 1:
        return path.as_posix() in PUBLIC_FILES
    if path.parts[0] in PUBLIC_DIRECTORIES or path.parts[0] == "admin-app":
        return True
    return (
        len(path.parts) >= 3 and path.parts[:2] == ("deploy", "docker")
    ) or path.as_posix() in DEPLOY_SUPPORT_FILES


def path_boundary_errors(path: PurePosixPath) -> list[str]:
    errors: list[str] = []
    if not source_path_allowed(path):
        errors.append(f"unexpected Docker package content: {path}")
    lower_parts = {part.lower() for part in path.parts}
    if lower_parts & FORBIDDEN_COMPONENTS:
        errors.append(f"secret/runtime path is forbidden: {path}")
    lower_name = path.name.lower()
    environment_file = (
        lower_name == ".env"
        or lower_name.startswith(".env.")
        or lower_name.endswith(".env")
        or ".env." in lower_name
    ) and not lower_name.endswith(".env.example")
    if environment_file:
        errors.append(f"environment file is forbidden: {path}")
    if lower_name in FORBIDDEN_CREDENTIAL_FILENAMES:
        errors.append(f"credential file is forbidden: {path}")
    if lower_name.endswith(FORBIDDEN_SUFFIXES):
        errors.append(f"secret/runtime file suffix is forbidden: {path}")
    lowered = path.as_posix().lower()
    if "team-shoot" in lowered or "/raw/" in f"/{lowered}/":
        errors.append(f"raw photo path is forbidden: {path}")
    return errors


def inspect_entry(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> tuple[str, int, set[str]]:
    digest = hashlib.sha256()
    detected: set[str] = set()
    size = 0
    tail = b""
    with archive.open(info) as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
            window = tail + chunk
            for label, pattern in SECRET_PATTERNS.items():
                if label not in detected and pattern.search(window):
                    detected.add(label)
            tail = window[-4096:]
    return digest.hexdigest(), size, detected


def archive_mode(info: zipfile.ZipInfo) -> int:
    return info.external_attr >> 16


def inspect_archive(filename: str | Path, expected_commit: str | None = None) -> dict[str, Any]:
    errors: list[str] = []
    if expected_commit is not None and not COMMIT_RE.fullmatch(expected_commit):
        errors.append("expected implementation SHA must be 40 or 64 lowercase hex characters")

    with zipfile.ZipFile(filename) as archive:
        infos = archive.infolist()
        raw_names = [info.filename for info in infos]
        if len(raw_names) != len(set(raw_names)):
            errors.append("archive contains duplicate filenames")

        relative_infos: dict[str, zipfile.ZipInfo] = {}
        roots: set[str] = set()
        for info in infos:
            name = info.filename[:-1] if info.is_dir() and info.filename.endswith("/") else info.filename
            path = normalized_entry(name)
            if path is None:
                errors.append(f"unsafe archive path: {info.filename!r}")
                continue
            roots.add(path.parts[0])
            mode = archive_mode(info)
            if stat.S_ISLNK(mode):
                errors.append(f"symlink is forbidden in Docker package: {info.filename}")
            if info.is_dir():
                errors.append(f"directory entries are forbidden in Docker package: {info.filename}")
                continue
            if not stat.S_ISREG(mode):
                errors.append(f"non-regular file is forbidden in Docker package: {info.filename}")
            if len(path.parts) < 2:
                errors.append(f"package file must be inside one payload root: {info.filename}")
                continue
            relative = PurePosixPath(*path.parts[1:])
            relative_name = relative.as_posix()
            if relative_name in relative_infos:
                errors.append(f"archive contains duplicate normalized path: {relative_name}")
                continue
            relative_infos[relative_name] = info
            if relative_name != MANIFEST_NAME:
                errors.extend(path_boundary_errors(relative))

        payload_root = next(iter(roots)) if len(roots) == 1 else None
        if payload_root is None:
            errors.append(f"archive must have exactly one payload root, got {sorted(roots)}")
        elif payload_root != PAYLOAD_ROOT:
            errors.append(f"payload root must be {PAYLOAD_ROOT}")

        missing = sorted(REQUIRED_FILES - set(relative_infos))
        if missing:
            errors.append(f"required Docker package files are missing: {missing}")

        inspected: dict[str, dict[str, Any]] = {}
        for path, info in relative_infos.items():
            if path == MANIFEST_NAME:
                continue
            digest, size, secrets = inspect_entry(archive, info)
            mode = archive_mode(info)
            file_mode = stat.S_IMODE(mode)
            inspected[path] = {
                "sha256": digest,
                "bytes": size,
                "mode": f"{file_mode:04o}",
            }
            if file_mode not in {0o644, 0o755}:
                errors.append(f"Docker package file mode must be 0644 or 0755: {path}")
            for label in sorted(secrets):
                errors.append(f"{label} detected in {path}")

        manifest: dict[str, Any] = {}
        manifest_info = relative_infos.get(MANIFEST_NAME)
        if manifest_info is None:
            errors.append(f"{MANIFEST_NAME} is missing")
        else:
            if stat.S_IMODE(archive_mode(manifest_info)) != 0o644:
                errors.append(f"{MANIFEST_NAME} mode must be 0644")
            _manifest_digest, _manifest_size, manifest_secrets = inspect_entry(
                archive, manifest_info
            )
            for label in sorted(manifest_secrets):
                errors.append(f"{label} detected in {MANIFEST_NAME}")
            try:
                decoded = json.loads(archive.read(manifest_info))
                if not isinstance(decoded, dict):
                    raise ValueError("top-level JSON value must be an object")
                manifest = decoded
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
                errors.append(f"invalid {MANIFEST_NAME}: {exc}")

        if manifest:
            if manifest.get("schemaVersion") != 1 or manifest.get("format") != PACKAGE_FORMAT:
                errors.append("Docker package manifest schema/format is unsupported")
            if manifest.get("version") != PACKAGE_VERSION:
                errors.append("Docker package manifest version is unsupported")
            if manifest.get("payloadRoot") != payload_root:
                errors.append("Docker package manifest payloadRoot does not match the archive")
            implementation_commit = manifest.get("implementationCommit")
            if not isinstance(implementation_commit, str) or not COMMIT_RE.fullmatch(implementation_commit):
                errors.append("Docker package manifest implementationCommit is invalid")
            elif expected_commit is not None and implementation_commit != expected_commit:
                errors.append("implementation SHA does not match the expected commit")
            files = manifest.get("files")
            if not isinstance(files, dict):
                errors.append("Docker package manifest files must be an object")
            else:
                if set(files) != set(inspected):
                    errors.append("Docker package manifest file set does not match the archive")
                for path, actual in inspected.items():
                    metadata = files.get(path)
                    if not isinstance(metadata, dict):
                        continue
                    if metadata.get("sha256") != actual["sha256"]:
                        errors.append(f"Docker package manifest checksum mismatch: {path}")
                    if metadata.get("bytes") != actual["bytes"]:
                        errors.append(f"Docker package manifest size mismatch: {path}")
                    if metadata.get("mode") != actual["mode"]:
                        errors.append(f"Docker package manifest mode mismatch: {path}")

        return {
            "archive": str(filename),
            "payloadRoot": payload_root,
            "implementationCommit": manifest.get("implementationCommit") if manifest else None,
            "files": len(inspected),
            "uncompressedBytes": sum(item["bytes"] for item in inspected.values()),
            "errors": errors,
            "status": "pass" if not errors else "fail",
        }


def checksum_errors(archive_path: Path, checksum_path: Path) -> list[str]:
    try:
        line = checksum_path.read_text(encoding="ascii").strip()
    except FileNotFoundError:
        return [f"archive checksum file is missing: {checksum_path.name}"]
    match = re.fullmatch(r"([0-9a-f]{64})  ([^/\s]+)", line)
    if match is None:
        return [f"invalid archive checksum record: {checksum_path.name}"]
    if match.group(2) != archive_path.name:
        return ["archive checksum filename does not match the ZIP"]
    actual = sha256(archive_path.read_bytes())
    if match.group(1) != actual:
        return ["archive checksum does not match the ZIP"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--expected-commit")
    parser.add_argument("--checksum", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    checksum_path = args.checksum or args.archive.with_name(f"{args.archive.name}.sha256")
    try:
        result = inspect_archive(args.archive, args.expected_commit)
        result["errors"].extend(checksum_errors(args.archive, checksum_path))
        result["status"] = "pass" if not result["errors"] else "fail"
    except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
        print(f"Docker archive check failed: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif result["errors"]:
        print("Docker archive check failed:", file=sys.stderr)
        for error in result["errors"]:
            print(f"- {error}", file=sys.stderr)
    else:
        print(
            f"Docker archive check passed: {result['files']} files for "
            f"{result['implementationCommit']}"
        )
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
