#!/usr/bin/env python3
"""Build the deterministic OKNOTIKA Docker handoff from one exact Git commit."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from check_docker_archive import (
    MANIFEST_NAME,
    PACKAGE_FORMAT,
    PACKAGE_VERSION,
    PAYLOAD_ROOT,
    REQUIRED_FILES,
    inspect_archive,
    source_path_allowed,
)


FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


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
    if len(value) not in {40, 64} or any(character not in "0123456789abcdef" for character in value):
        raise RuntimeError("Git returned an unsupported implementation commit SHA")
    return value


def source_entries(repo: Path, commit: str) -> list[tuple[PurePosixPath, int]]:
    entries: list[tuple[PurePosixPath, int]] = []
    for item in run_git(repo, "ls-tree", "-rz", commit).split(b"\0"):
        if not item:
            continue
        metadata, raw_path = item.split(b"\t", 1)
        raw_mode, object_type, _object_id = metadata.split(b" ", 2)
        path = PurePosixPath(raw_path.decode("utf-8"))
        if not source_path_allowed(path):
            continue
        if object_type != b"blob" or raw_mode not in {b"100644", b"100755"}:
            raise RuntimeError(f"Docker package source must be a regular file: {path}")
        entries.append((path, int(raw_mode, 8)))
    entries.sort(key=lambda entry: entry[0].as_posix())
    missing = sorted(REQUIRED_FILES - {path.as_posix() for path, _mode in entries})
    if missing:
        raise RuntimeError(f"required committed Docker package sources are missing: {missing}")
    return entries


def git_blob(repo: Path, commit: str, path: PurePosixPath) -> bytes:
    return run_git(repo, "cat-file", "blob", f"{commit}:{path.as_posix()}")


def status_paths(repo: Path) -> list[str]:
    records = run_git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all").split(b"\0")
    paths: list[str] = []
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        status = record[:2].decode("ascii")
        paths.append(record[3:].decode("utf-8"))
        if "R" in status or "C" in status:
            if index < len(records) and records[index]:
                paths.append(records[index].decode("utf-8"))
                index += 1
    return paths


def ensure_clean_payload_worktree(repo: Path) -> None:
    dirty = sorted(
        {
            path
            for path in status_paths(repo)
            if source_path_allowed(PurePosixPath(path))
        }
    )
    if dirty:
        raise RuntimeError(f"Docker package payload worktree must be clean: {', '.join(dirty)}")


def zip_info(name: str, mode: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, FIXED_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | mode) << 16
    return info


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_package(repo: Path, commit: str, output: Path) -> dict[str, object]:
    repo = repo.resolve()
    ensure_clean_payload_worktree(repo)
    implementation_commit = resolve_commit(repo, commit)
    entries = source_entries(repo, implementation_commit)
    payload: dict[str, bytes] = {}
    modes: dict[str, int] = {}
    for path, git_mode in entries:
        name = path.as_posix()
        payload[name] = git_blob(repo, implementation_commit, path)
        modes[name] = 0o755 if git_mode & 0o100 else 0o644

    manifest = {
        "schemaVersion": 1,
        "format": PACKAGE_FORMAT,
        "version": PACKAGE_VERSION,
        "implementationCommit": implementation_commit,
        "payloadRoot": PAYLOAD_ROOT,
        "files": {
            path: {
                "sha256": sha256(data),
                "bytes": len(data),
                "mode": f"{modes[path]:04o}",
            }
            for path, data in sorted(payload.items())
        },
    }
    manifest_data = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()

    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_handle = tempfile.NamedTemporaryFile(
        prefix=f".{output.name}.", suffix=".tmp", dir=output.parent, delete=False
    )
    temporary = Path(temporary_handle.name)
    temporary_handle.close()
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for path, data in sorted(payload.items()):
                archive.writestr(zip_info(f"{PAYLOAD_ROOT}/{path}", modes[path]), data)
            archive.writestr(zip_info(f"{PAYLOAD_ROOT}/{MANIFEST_NAME}", 0o644), manifest_data)
        result = inspect_archive(temporary, implementation_commit)
        if result["errors"]:
            raise RuntimeError("built Docker package failed validation: " + "; ".join(result["errors"]))
        os.replace(temporary, output)
        output.chmod(0o644)
    finally:
        temporary.unlink(missing_ok=True)

    archive_hash = sha256(output.read_bytes())
    checksum = output.with_name(f"{output.name}.sha256")
    checksum_data = f"{archive_hash}  {output.name}\n".encode("ascii")
    checksum_handle = tempfile.NamedTemporaryFile(
        prefix=f".{checksum.name}.", suffix=".tmp", dir=output.parent, delete=False
    )
    checksum_temporary = Path(checksum_handle.name)
    try:
        checksum_handle.write(checksum_data)
        checksum_handle.flush()
        os.fsync(checksum_handle.fileno())
    finally:
        checksum_handle.close()
    try:
        os.replace(checksum_temporary, checksum)
        checksum.chmod(0o644)
    finally:
        checksum_temporary.unlink(missing_ok=True)

    return {
        "output": str(output),
        "checksum": str(checksum),
        "implementationCommit": implementation_commit,
        "files": len(payload),
        "sha256": archive_hash,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--commit", default="HEAD")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repo = args.repo.resolve()
    output = args.output if args.output.is_absolute() else repo / args.output
    try:
        result = build_package(repo, args.commit, output)
    except (OSError, RuntimeError, subprocess.CalledProcessError, zipfile.BadZipFile) as exc:
        print(f"Docker package build failed: {exc}", file=sys.stderr)
        return 1
    print(
        f"Built {result['output']}: {result['files']} files for "
        f"{result['implementationCommit']}, sha256 {result['sha256']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
