#!/usr/bin/env python3
"""Validate the simple, secret-free OKNOTIKA Docker handoff archive."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


PACKAGE_VERSION = "v2.29.0-rc.4"
ARCHIVE_ROOTS = {"admin-app", "public-app", "deploy"}
COMMIT_RE = re.compile(r"^[a-f0-9]{40}(?:[a-f0-9]{24})?$")
PUBLIC_SOURCE_FILES = {"index.html", "script.js", "style.css"}
PUBLIC_SOURCE_DIRECTORIES = {
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
DEPLOY_SOURCE_MAP = {
    "deploy/scripts/smoke-weekly-ingestion.mjs": "deploy/scripts/smoke-weekly-ingestion.mjs",
    "deploy/nginx/snippets/public-security-headers.conf": (
        "deploy/nginx/snippets/public-security-headers.conf"
    ),
    "docs/WEEKLY_INGESTION.md": "deploy/docs/WEEKLY_INGESTION.md",
}
REQUIRED_SOURCE_FILES = {
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
    *DEPLOY_SOURCE_MAP,
}
FORBIDDEN_COMPONENTS = {
    ".git",
    ".ralphex",
    ".tmp-inputs",
    "__pycache__",
    "data",
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


def run_git(repo: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout


def resolve_commit(repo: Path, commit: str) -> str:
    resolved = run_git(repo, "rev-parse", "--verify", "--end-of-options", f"{commit}^{{commit}}")
    value = resolved.decode("ascii").strip()
    if not COMMIT_RE.fullmatch(value):
        raise RuntimeError("Git returned an unsupported implementation commit SHA")
    return value


def source_to_archive(path: PurePosixPath) -> PurePosixPath | None:
    source = path.as_posix()
    if path.parts and path.parts[0] == "admin-app":
        return path
    if len(path.parts) == 1 and source in PUBLIC_SOURCE_FILES:
        return PurePosixPath("public-app", source)
    if path.parts and path.parts[0] in PUBLIC_SOURCE_DIRECTORIES:
        return PurePosixPath("public-app", *path.parts)
    if len(path.parts) >= 3 and path.parts[:2] == ("deploy", "docker"):
        return path
    mapped = DEPLOY_SOURCE_MAP.get(source)
    return PurePosixPath(mapped) if mapped is not None else None


def source_path_allowed(path: PurePosixPath) -> bool:
    return source_to_archive(path) is not None


def expected_payload(
    repo: Path, commit: str
) -> tuple[str, dict[str, bytes], dict[str, int]]:
    repo = repo.resolve()
    implementation_commit = resolve_commit(repo, commit)
    payload: dict[str, bytes] = {}
    modes: dict[str, int] = {}
    included_sources: set[str] = set()
    for item in run_git(repo, "ls-tree", "-rz", implementation_commit).split(b"\0"):
        if not item:
            continue
        metadata, raw_path = item.split(b"\t", 1)
        raw_mode, object_type, _object_id = metadata.split(b" ", 2)
        source_path = PurePosixPath(raw_path.decode("utf-8"))
        archive_path = source_to_archive(source_path)
        if archive_path is None:
            continue
        if object_type != b"blob" or raw_mode not in {b"100644", b"100755"}:
            raise RuntimeError(f"Docker package source must be a regular file: {source_path}")
        source_name = source_path.as_posix()
        archive_name = archive_path.as_posix()
        if archive_name in payload:
            raise RuntimeError(f"Docker package archive mapping collides at: {archive_name}")
        payload[archive_name] = run_git(
            repo, "cat-file", "blob", f"{implementation_commit}:{source_name}"
        )
        modes[archive_name] = 0o755 if int(raw_mode, 8) & 0o100 else 0o644
        included_sources.add(source_name)
    missing = sorted(REQUIRED_SOURCE_FILES - included_sources)
    if missing:
        raise RuntimeError(f"required committed Docker package sources are missing: {missing}")
    return implementation_commit, payload, modes


REQUIRED_FILES = {
    mapped.as_posix()
    for source in REQUIRED_SOURCE_FILES
    if (mapped := source_to_archive(PurePosixPath(source))) is not None
}


def normalized_entry(name: str) -> PurePosixPath | None:
    if not name or "\\" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        return None
    path = PurePosixPath(name)
    if path.as_posix() != name or any(part in {"", ".", ".."} for part in path.parts):
        return None
    return path


def archive_path_allowed(path: PurePosixPath) -> bool:
    if len(path.parts) < 2:
        return False
    root = path.parts[0]
    relative = PurePosixPath(*path.parts[1:])
    if root == "admin-app":
        return True
    if root == "public-app":
        return (
            len(relative.parts) == 1 and relative.as_posix() in PUBLIC_SOURCE_FILES
        ) or relative.parts[0] in PUBLIC_SOURCE_DIRECTORIES
    if root != "deploy":
        return False
    return (
        len(path.parts) >= 3 and path.parts[:2] == ("deploy", "docker")
    ) or path.as_posix() in set(DEPLOY_SOURCE_MAP.values())


def path_boundary_errors(path: PurePosixPath) -> list[str]:
    errors: list[str] = []
    if not archive_path_allowed(path):
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


def inspect_archive(
    filename: str | Path,
    expected_commit: str | None = None,
    repo: Path | None = None,
) -> dict[str, Any]:
    errors: list[str] = []
    implementation_commit: str | None = None
    committed_payload: dict[str, bytes] | None = None
    committed_modes: dict[str, int] | None = None
    if expected_commit is not None:
        if repo is None:
            errors.append("repository is required for committed payload verification")
        else:
            implementation_commit, committed_payload, committed_modes = expected_payload(
                repo, expected_commit
            )

    with zipfile.ZipFile(filename) as archive:
        infos = archive.infolist()
        raw_names = [info.filename for info in infos]
        if len(raw_names) != len(set(raw_names)):
            errors.append("archive contains duplicate filenames")

        file_infos: dict[str, zipfile.ZipInfo] = {}
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
                errors.append(f"package file must be inside an approved archive root: {info.filename}")
                continue
            archive_name = path.as_posix()
            if archive_name in file_infos:
                errors.append(f"archive contains duplicate normalized path: {archive_name}")
                continue
            file_infos[archive_name] = info
            errors.extend(path_boundary_errors(path))

        if roots != ARCHIVE_ROOTS:
            errors.append(
                f"archive roots must be exactly {sorted(ARCHIVE_ROOTS)}, got {sorted(roots)}"
            )

        missing = sorted(REQUIRED_FILES - set(file_infos))
        if missing:
            errors.append(f"required Docker package files are missing: {missing}")

        if committed_payload is not None and set(file_infos) != set(committed_payload):
            errors.append("archive file set does not match the committed Docker payload")

        inspected: dict[str, dict[str, Any]] = {}
        for path, info in file_infos.items():
            digest, size, secrets = inspect_entry(archive, info)
            file_mode = stat.S_IMODE(archive_mode(info))
            inspected[path] = {
                "sha256": digest,
                "bytes": size,
                "mode": f"{file_mode:04o}",
            }
            if file_mode not in {0o644, 0o755}:
                errors.append(f"Docker package file mode must be 0644 or 0755: {path}")
            for label in sorted(secrets):
                errors.append(f"{label} detected in {path}")
            if committed_payload is not None and path in committed_payload:
                expected_data = committed_payload[path]
                if digest != sha256(expected_data) or size != len(expected_data):
                    errors.append(f"committed source content mismatch: {path}")
                if committed_modes is not None and file_mode != committed_modes[path]:
                    errors.append(f"committed source mode mismatch: {path}")

        return {
            "archive": str(filename),
            "roots": sorted(roots),
            "implementationCommit": implementation_commit,
            "files": len(inspected),
            "uncompressedBytes": sum(item["bytes"] for item in inspected.values()),
            "archiveSha256": sha256(Path(filename).read_bytes()),
            "errors": errors,
            "status": "pass" if not errors else "fail",
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--expected-commit", default="HEAD")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        result = inspect_archive(args.archive, args.expected_commit, args.repo)
    except (OSError, RuntimeError, subprocess.CalledProcessError, zipfile.BadZipFile) as exc:
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
            f"Docker archive check passed: {result['files']} files in "
            f"{', '.join(result['roots'])} for {result['implementationCommit']}"
        )
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
