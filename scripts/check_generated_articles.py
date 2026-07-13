#!/usr/bin/env python3
"""Validate an immutable generated article release without serving it."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


REVALIDATE = "public, max-age=0, must-revalidate"
IMMUTABLE = "public, max-age=31536000, immutable"


def fail(message: str) -> None:
    raise SystemExit(f"generated articles check failed: {message}")


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: check_generated_articles.py RELEASE_DIRECTORY")
    root = Path(sys.argv[1]).resolve()
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        fail("manifest.json is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = set(manifest.get("files", {}))
    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path != manifest_path
    }
    if actual != expected:
        fail(f"manifest file set differs: missing={expected - actual}, extra={actual - expected}")
    for relative, metadata in manifest["files"].items():
        path = root / relative
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != metadata.get("sha256"):
            fail(f"hash mismatch for {relative}")
        cache = IMMUTABLE if relative.startswith("articles/assets/") else REVALIDATE
        if metadata.get("cacheControl") != cache:
            fail(f"wrong cache contract for {relative}")
    latest = json.loads((root / "articles/latest.json").read_text(encoding="utf-8"))
    if latest is not None:
        if latest.get("category") != "Факт недели":
            fail("latest category is not fixed")
        if not latest.get("url", "").startswith("https://oknotika.ru/articles/"):
            fail("latest URL is not canonical")
    gone = json.loads((root / "410-map.json").read_text(encoding="utf-8"))
    if not isinstance(gone.get("paths"), list):
        fail("410 map is invalid")
    print(f"generated articles check passed: {manifest['releaseId']} ({len(actual)} files)")


if __name__ == "__main__":
    main()
