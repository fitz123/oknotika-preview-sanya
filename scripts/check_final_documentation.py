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


VERSION = "v2.28.0-beta.1"
BASELINE = "5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed"
STALE_MARKERS = ("V2.18", "V2.25")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(text: str, path: str, needles: tuple[str, ...], errors: list[str]) -> None:
    for needle in needles:
        if needle not in text:
            errors.append(f"{path} is missing {needle!r}")


def validate_readme_text(text: str) -> list[str]:
    errors = [f"README.md retains stale marker {marker}" for marker in STALE_MARKERS if marker in text]
    require(text, "README.md", (
        "# ОКНОТИКА — финальный beta-релиз сайта",
        "## Content model «Факта недели»",
        "## Telegram enrollment и доступ",
        "## Editor flow",
        "## Полная локальная валидация",
        "## Release и эксплуатация",
        "admin-app/ENROLLMENT.md",
        "deploy/README_ZHENYA.md",
        "release/CHANGED_FILES-v2.28.0-beta.1.txt",
        "Архитектурный ADR намеренно не создан",
    ), errors)
    return errors


def validate_public_html_text(text: str, path: str = "index.html") -> list[str]:
    return [f"{path} retains stale marker {marker}" for marker in STALE_MARKERS if marker in text]


def parse_checksums(path: Path) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (\S+)", line)
        if not match:
            raise ValueError(f"invalid checksum line: {line!r}")
        checksums[match.group(2)] = match.group(1)
    return checksums


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
        "issuer` + `sub",
        "npm run enroll",
        "не используются как идентификатор доступа",
    ), errors)

    deploy = (root / "deploy/README_ZHENYA.md").read_text(encoding="utf-8")
    require(deploy, "deploy/README_ZHENYA.md", (
        "## Backup и restore",
        "## Emergency disable",
        "Content rollback",
        "Marketing rollback",
        "Application rollback",
        "## Первичное подключение редактора",
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

    notes = (release / f"RELEASE_NOTES-{VERSION}.md").read_text(encoding="utf-8")
    require(notes, f"RELEASE_NOTES-{VERSION}.md", (
        implementation,
        BASELINE,
        "SHA256SUMS",
        f"CHANGED_FILES-{VERSION}.txt",
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
    if checksums != {versioned_name: versioned_hash, stable.name: stable_hash}:
        errors.append("SHA256SUMS does not match both release archives")
    if versioned_hash != stable_hash or versioned.read_bytes() != stable.read_bytes():
        errors.append("stable and versioned release archives differ")
    if manifest.get("archiveSha256") != versioned_hash or manifest.get("archiveBytes") != versioned.stat().st_size:
        errors.append("external release manifest archive hash/size is stale")

    scan = scan_archive(str(versioned))
    errors.extend(f"release scan: {error}" for error in scan["errors"])
    if manifest.get("files") != scan["files"] or manifest.get("uncompressedBytes") != scan["uncompressedBytes"]:
        errors.append("external release manifest file/byte counts are stale")

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
