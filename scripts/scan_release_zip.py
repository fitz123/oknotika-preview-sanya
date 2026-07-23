#!/usr/bin/env python3
"""Fail closed when an OKNOTIKA release ZIP contains private or unsafe data."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import sys
import zipfile
from pathlib import PurePosixPath
from typing import Any


FORBIDDEN_COMPONENTS = {
    ".git",
    ".ralphex",
    ".tmp-inputs",
    "__pycache__",
    "node_modules",
    "uploads",
    "previews",
    "article-releases",
    "var",
}
FORBIDDEN_SUFFIXES = (".sqlite", ".sqlite-wal", ".sqlite-shm", ".log", ".pem", ".key")
SECRET_PATTERNS = {
    "private key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "Telegram bot token": re.compile(rb"(?<![A-Za-z0-9])\d{8,12}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9])"),
    "GitHub token": re.compile(rb"\bgh[ps]_[A-Za-z0-9]{30,}\b"),
    "AWS access key": re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    "assigned OIDC secret": re.compile(rb"TELEGRAM_OIDC_CLIENT_SECRET\s*=\s*[^\s<#${][^\r\n]*"),
    "assigned restic password": re.compile(rb"RESTIC_PASSWORD\s*=\s*[^\s<#${][^\r\n]*"),
}
REQUIRED_PATHS = {
    "CHANGED_FILES.txt",
    "README.md",
    "RELEASE_NOTES.md",
    "RELEASE_MANIFEST.json",
    "index.html",
    "admin-app/package-lock.json",
    "deploy/README_ZHENYA.md",
    "deploy/systemd/oknotika-admin.service",
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalized_entry(name: str) -> PurePosixPath | None:
    if not name or "\\" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        return None
    path = PurePosixPath(name)
    if any(part in {"", ".", ".."} for part in path.parts):
        return None
    return path


def scan_entry_for_secrets(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> set[str]:
    detected: set[str] = set()
    tail = b""
    with archive.open(info) as stream:
        while chunk := stream.read(1024 * 1024):
            window = tail + chunk
            for label, pattern in SECRET_PATTERNS.items():
                if label not in detected and pattern.search(window):
                    detected.add(label)
            tail = window[-4096:]
    return detected


def scan_archive(filename: str) -> dict[str, Any]:
    errors: list[str] = []
    with zipfile.ZipFile(filename) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos if not info.is_dir()]
        if len(names) != len(set(names)):
            errors.append("archive contains duplicate filenames")
        roots: set[str] = set()
        relative_infos: dict[str, zipfile.ZipInfo] = {}
        for info in infos:
            path = normalized_entry(info.filename.rstrip("/"))
            if path is None:
                errors.append(f"unsafe archive path: {info.filename!r}")
                continue
            roots.add(path.parts[0])
            if stat.S_ISLNK(info.external_attr >> 16):
                errors.append(f"symlink is forbidden in release ZIP: {info.filename}")
            if info.is_dir() or len(path.parts) < 2:
                continue
            relative = PurePosixPath(*path.parts[1:])
            relative_infos[str(relative)] = info
            lower_parts = {part.lower() for part in relative.parts}
            if lower_parts & FORBIDDEN_COMPONENTS:
                errors.append(f"private/runtime path is forbidden: {relative}")
            lower_name = relative.name.lower()
            environment_file = (
                lower_name == ".env"
                or lower_name.startswith(".env.")
                or lower_name.endswith(".env")
                or ".env." in lower_name
            ) and not lower_name.endswith(".env.example")
            if environment_file:
                errors.append(f"environment file is forbidden: {relative}")
            if lower_name.endswith(FORBIDDEN_SUFFIXES):
                errors.append(f"secret/runtime file suffix is forbidden: {relative}")
            if "team-shoot" in str(relative).lower() or "/raw/" in f"/{str(relative).lower()}/":
                errors.append(f"raw photo path is forbidden: {relative}")
            for label in scan_entry_for_secrets(archive, info):
                errors.append(f"{label} detected in {relative}")
        if len(roots) != 1:
            errors.append(f"archive must have exactly one payload root, got {sorted(roots)}")
        missing = sorted(REQUIRED_PATHS - set(relative_infos))
        if missing:
            errors.append(f"required release files are missing: {missing}")

        manifest: dict[str, Any] = {}
        manifest_info = relative_infos.get("RELEASE_MANIFEST.json")
        if manifest_info:
            try:
                manifest = json.loads(archive.read(manifest_info))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                errors.append(f"invalid RELEASE_MANIFEST.json: {exc}")
            files = manifest.get("files", {}) if isinstance(manifest, dict) else {}
            expected_paths = set(relative_infos) - {"RELEASE_MANIFEST.json"}
            if set(files) != expected_paths:
                errors.append("release manifest file set does not match the archive")
            for path, metadata in files.items():
                info = relative_infos.get(path)
                if info is None or not isinstance(metadata, dict):
                    continue
                data = archive.read(info)
                if metadata.get("sha256") != digest(data) or metadata.get("bytes") != len(data):
                    errors.append(f"release manifest hash/size mismatch: {path}")
        return {
            "archive": filename,
            "payloadRoot": next(iter(roots)) if len(roots) == 1 else None,
            "files": len(relative_infos),
            "uncompressedBytes": sum(info.file_size for info in relative_infos.values()),
            "manifestVersion": manifest.get("version") if isinstance(manifest, dict) else None,
            "errors": errors,
            "status": "pass" if not errors else "fail",
        }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        result = scan_archive(args.archive)
    except (OSError, zipfile.BadZipFile) as exc:
        print(f"release ZIP scan failed: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    elif result["errors"]:
        print("release ZIP scan failed:", file=sys.stderr)
        for error in result["errors"]:
            print(f"- {error}", file=sys.stderr)
    else:
        print(f"release ZIP scan passed: {result['files']} files, {result['uncompressedBytes']} bytes")
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
