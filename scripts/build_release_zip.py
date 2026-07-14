#!/usr/bin/env python3
"""Build a deterministic, versioned, secret-free OKNOTIKA release ZIP."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import stat
import subprocess
import sys
import zipfile
from pathlib import Path

from scan_release_zip import scan_archive


VERSION = "v2.28.0-beta.1"
FIXED_TIMESTAMP = (2026, 7, 14, 0, 0, 0)
TOP_LEVEL_FILES = {
    ".gitignore", "ALUMINUM_SOURCES.md", "IMAGE_SOURCES.md", "README.md", "index.html", "script.js", "style.css",
}
TOP_LEVEL_DIRECTORIES = {
    "admin-app", "aluminum", "articles", "carbon-glass", "deploy", "docs", "glass", "img", "js",
    "oknotika-smart-window", "protectapeel", "pvc", "release-evidence", "scripts", "tests", "tools", "wood-stoller",
}
EXCLUDED_COMPONENTS = {
    ".git", ".ralphex", ".tmp-inputs", "__pycache__", "node_modules", "release", "uploads", "previews", "var",
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_paths(repo: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "-C", str(repo), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        check=True,
        stdout=subprocess.PIPE,
    )
    paths = []
    for item in result.stdout.split(b"\0"):
        if not item:
            continue
        relative = Path(item.decode())
        if relative.name in {".DS_Store"} or any(part in EXCLUDED_COMPONENTS for part in relative.parts):
            continue
        if relative.parts[0] == "docs" and len(relative.parts) > 1 and relative.parts[1] == "plans":
            continue
        if relative.parts[0] not in TOP_LEVEL_DIRECTORIES and str(relative) not in TOP_LEVEL_FILES:
            continue
        path = repo / relative
        if path.is_file() and not path.is_symlink():
            paths.append(relative)
    return sorted(paths, key=lambda path: path.as_posix())


def zip_info(name: str, mode: int = 0o644) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, FIXED_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | mode) << 16
    return info


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--version", default=VERSION)
    parser.add_argument("--notes", type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
    release = repo / "release"
    release.mkdir(parents=True, exist_ok=True)
    version = args.version
    notes = args.notes or release / f"RELEASE_NOTES-{version}.md"
    if not notes.is_file():
        print(f"release notes are missing: {notes}", file=sys.stderr)
        return 1
    payload_root = f"oknotika-final-{version}"
    paths = source_paths(repo)
    payload: dict[str, bytes] = {path.as_posix(): (repo / path).read_bytes() for path in paths}
    payload["RELEASE_NOTES.md"] = notes.read_bytes()
    source_commit = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], check=True, stdout=subprocess.PIPE, text=True
    ).stdout.strip()
    manifest = {
        "schemaVersion": 1,
        "version": version,
        "sourceCommitBeforeTask7": source_commit,
        "baselineCommit": "5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed",
        "generatedAt": "2026-07-14T00:00:00Z",
        "files": {
            path: {
                "sha256": sha256(data),
                "bytes": len(data),
                "mode": "0755" if path.startswith("deploy/scripts/") and (repo / path).exists() and (repo / path).stat().st_mode & stat.S_IXUSR else "0644",
            }
            for path, data in sorted(payload.items())
        },
    }
    payload["RELEASE_MANIFEST.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    versioned = release / f"oknotika-final-{version}.zip"
    with zipfile.ZipFile(versioned, "w", compresslevel=9) as archive:
        for path, data in sorted(payload.items()):
            executable = path.startswith("deploy/scripts/") and (repo / path).exists() and (repo / path).stat().st_mode & stat.S_IXUSR
            archive.writestr(zip_info(f"{payload_root}/{path}", 0o755 if executable else 0o644), data)
    stable = release / "oknotika-final.zip"
    shutil.copyfile(versioned, stable)
    result = scan_archive(str(versioned))
    if result["errors"]:
        for error in result["errors"]:
            print(f"release ZIP scan failed: {error}", file=sys.stderr)
        return 1
    archive_hash = sha256(versioned.read_bytes())
    (release / "SHA256SUMS").write_text(
        f"{archive_hash}  {versioned.name}\n{archive_hash}  {stable.name}\n",
        encoding="utf-8",
    )
    external_manifest = {
        "schemaVersion": 1,
        "version": version,
        "payloadRoot": payload_root,
        "archiveSha256": archive_hash,
        "archiveBytes": versioned.stat().st_size,
        "files": result["files"],
        "uncompressedBytes": result["uncompressedBytes"],
        "sourceCommitBeforeTask7": source_commit,
        "secretScan": "pass",
    }
    (release / f"release-manifest-{version}.json").write_text(
        json.dumps(external_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Built {versioned.name}: {result['files']} files, sha256 {archive_hash}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
