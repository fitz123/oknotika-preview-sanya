#!/usr/bin/env python3
"""Reject high-risk public claims before static pages are released."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


PUBLIC_EXCLUDES = {".git", ".ralphex", ".tmp-inputs", "admin-app", "deploy", "release-evidence", "var"}


def public_html(repo: Path) -> list[Path]:
    return sorted(
        path
        for path in repo.rglob("*.html")
        if not any(part in PUBLIC_EXCLUDES for part in path.relative_to(repo).parts)
        and not re.fullmatch(r"index\.v\d+-before-v\d+\.html", path.name)
    )


def validate(repo: Path) -> list[str]:
    errors: list[str] = []
    forbidden = {
        r"генеральный\s+директор": "legacy Zhalnin role",
        r"schüco.{0,80}официальн\w*\s+(?:партн[её]р|дилер)": "unverified official Schüco relationship",
        r"официальн\w*\s+(?:партн[её]р|дилер).{0,80}schüco": "unverified official Schüco relationship",
        r"schüco.{0,120}скрыт\w*\s+дренаж\w*.{0,80}(?:во\s+всех|для\s+всех|у\s+всех|системах)": "generalised Schüco drainage",
    }
    files = public_html(repo)
    if not files:
        return ["no public HTML files found"]
    for path in files:
        text = " ".join(path.read_text(encoding="utf-8").split()).casefold()
        for pattern, label in forbidden.items():
            if re.search(pattern, text):
                errors.append(f"{path.relative_to(repo)}: {label}")
    aluminum = (repo / "aluminum/index.html").read_text(encoding="utf-8")
    drainage_count = len(re.findall(r"\bдренаж\w*", aluminum, flags=re.IGNORECASE))
    if drainage_count != 1:
        errors.append(f"aluminum/index.html: concealed drainage must occur once, found {drainage_count}")
    if 'data-claim-scope="aws-75-pd-si"' not in aluminum:
        errors.append("aluminum/index.html: AWS 75 PD.SI drainage scope is missing")
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path, nargs="?", default=Path("."))
    args = parser.parse_args(argv)
    errors = validate(args.repo.resolve())
    if errors:
        print("Public claim check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"Public claim check passed: {len(public_html(args.repo.resolve()))} HTML pages scanned")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
