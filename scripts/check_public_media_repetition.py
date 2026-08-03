#!/usr/bin/env python3
"""Reject repeated visible local images within affected public pages."""

from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


PUBLIC_PAGES = (
    Path("index.html"),
    Path("aluminum/index.html"),
    Path("glass/index.html"),
    Path("pvc/index.html"),
    Path("carbon-glass/index.html"),
    Path("oknotika-smart-window/index.html"),
    Path("protectapeel/index.html"),
    Path("wood-stoller/index.html"),
)
IMAGE_SUFFIXES = {".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"}
LOGO_PATHS = {"img/logo-oknotika.svg"}
CSS_URL = re.compile(r"url\(\s*(['\"]?)([^'\")]+)\1\s*\)", re.IGNORECASE)


class MediaParser(HTMLParser):
    def __init__(self, page: Path, repo: Path) -> None:
        super().__init__(convert_charrefs=True)
        self.page = page
        self.repo = repo
        self.uses: dict[str, dict[str, str]] = defaultdict(dict)
        self.stack: list[tuple[str, int | None]] = []
        self.picture_count = 0
        self.element_count = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.element_count += 1
        attributes = {name.casefold(): value or "" for name, value in attrs}
        picture_id = next((identifier for name, identifier in reversed(self.stack) if name == "picture"), None)
        if tag == "picture":
            self.picture_count += 1
            picture_id = self.picture_count

        classes = set(attributes.get("class", "").split())
        ignore_element = "brand__logo" in classes
        group = f"picture:{picture_id}" if picture_id is not None else f"element:{self.element_count}"

        if tag == "img" and not ignore_element:
            self._record(attributes.get("src", ""), group, "image")
            self._record_srcset(attributes.get("srcset", ""), group, "responsive image")
        elif tag == "source" and picture_id is not None:
            self._record(attributes.get("src", ""), group, "responsive image")
            self._record_srcset(attributes.get("srcset", ""), group, "responsive image")
        elif tag == "video":
            self._record(attributes.get("poster", ""), group, "video poster")

        if not ignore_element:
            for match in CSS_URL.finditer(attributes.get("style", "")):
                self._record(match.group(2), group, "background image")

        self.stack.append((tag, picture_id if tag == "picture" else None))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.stack.pop()

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                return

    def _record_srcset(self, srcset: str, group: str, role: str) -> None:
        for candidate in srcset.split(","):
            value = candidate.strip().split()
            if value:
                self._record(value[0], group, role)

    def _record(self, raw_reference: str, group: str, role: str) -> None:
        normalized = normalize_image_reference(raw_reference, self.page, self.repo)
        if normalized is None or normalized in LOGO_PATHS:
            return
        line, column = self.getpos()
        self.uses[normalized].setdefault(group, f"{role} at {line}:{column + 1}")


def normalize_image_reference(raw_reference: str, page: Path, repo: Path) -> str | None:
    reference = raw_reference.strip()
    if not reference or reference.startswith(("#", "//", "data:", "blob:")):
        return None
    parsed = urlsplit(reference)
    if parsed.scheme or parsed.netloc:
        return None
    relative = unquote(parsed.path)
    if not relative:
        return None
    target = (page.parent / relative).resolve()
    try:
        normalized = target.relative_to(repo.resolve()).as_posix()
    except ValueError:
        return None
    if Path(normalized).suffix.casefold() not in IMAGE_SUFFIXES:
        return None
    return normalized


def validate_page(page: Path, repo: Path) -> list[str]:
    parser = MediaParser(page.resolve(), repo.resolve())
    parser.feed(page.read_text(encoding="utf-8"))
    relative_page = page.resolve().relative_to(repo.resolve()).as_posix()
    errors: list[str] = []
    for media, occurrences in sorted(parser.uses.items()):
        if len(occurrences) > 1:
            locations = ", ".join(occurrences.values())
            errors.append(f"{relative_page}: repeated local media {media} ({locations})")
    return errors


def validate(repo: Path) -> list[str]:
    repo = repo.resolve()
    errors: list[str] = []
    for relative_page in PUBLIC_PAGES:
        page = repo / relative_page
        if not page.is_file():
            errors.append(f"affected public page is missing: {relative_page.as_posix()}")
            continue
        errors.extend(validate_page(page, repo))
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", nargs="?", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    try:
        errors = validate(args.repo)
    except OSError as exc:
        print(f"Public media repetition check failed: {exc}", file=sys.stderr)
        return 1
    if errors:
        print("Public media repetition check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"Public media repetition check passed: {len(PUBLIC_PAGES)} affected pages have unique visible local media")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
