#!/usr/bin/env python3
"""Build the deterministic OKNOTIKA Docker handoff from one exact Git commit."""

from __future__ import annotations

import argparse
import hashlib
import os
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from check_docker_archive import (
    expected_payload,
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
    implementation_commit, payload, modes = expected_payload(repo, commit)

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
                archive.writestr(zip_info(path, modes[path]), data)
        result = inspect_archive(temporary, implementation_commit, repo)
        if result["errors"]:
            raise RuntimeError("built Docker package failed validation: " + "; ".join(result["errors"]))
        os.replace(temporary, output)
        output.chmod(0o644)
    finally:
        temporary.unlink(missing_ok=True)

    archive_hash = sha256(output.read_bytes())
    return {
        "output": str(output),
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
