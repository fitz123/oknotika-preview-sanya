#!/usr/bin/env python3
"""Validate local references in the public static site.

The checker intentionally ignores private/build trees and never performs network
requests.  HTML references, CSS url()/@import values, and root-absolute fetch()
calls in public JavaScript are resolved against the repository root.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


EXCLUDED_DIRS = {
    ".git",
    ".ralphex",
    ".tmp-inputs",
    "admin-app",
    "deploy",
    "docs",
    "node_modules",
    "release",
    "release-evidence",
    "scripts",
    "tests",
    "tools",
    "var",
}
HTML_URL_ATTRIBUTES = {"action", "data-src", "href", "poster", "src"}
CSS_URL_RE = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.IGNORECASE)
CSS_IMPORT_RE = re.compile(r"@import\s+(?:url\(\s*)?(['\"])(.*?)\1", re.IGNORECASE)
ROOT_FETCH_RE = re.compile(r"\bfetch\(\s*(['\"])(/[^'\"]*)\1")
SKIPPED_SCHEMES = {"data", "http", "https", "mailto", "tel"}


@dataclass(frozen=True)
class Reference:
    source: Path
    value: str
    line: int


class ReferenceParser(HTMLParser):
    def __init__(self, source: Path) -> None:
        super().__init__(convert_charrefs=True)
        self.source = source
        self.references: list[Reference] = []
        self.anchors: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        line, _ = self.getpos()
        for name, value in attrs:
            if value is None:
                continue
            key = name.lower()
            if key in {"id", "name"}:
                self.anchors.add(value)
            if key in HTML_URL_ATTRIBUTES:
                self.references.append(Reference(self.source, value, line))
            elif key == "srcset":
                for candidate in value.split(","):
                    url = candidate.strip().split(maxsplit=1)[0]
                    if url:
                        self.references.append(Reference(self.source, url, line))
            elif key == "style":
                for match in CSS_URL_RE.finditer(value):
                    self.references.append(Reference(self.source, match.group(2), line))


def is_public_file(path: Path, root: Path) -> bool:
    relative = path.relative_to(root)
    return not any(part in EXCLUDED_DIRS for part in relative.parts[:-1])


def collect_html(root: Path) -> tuple[list[Reference], dict[Path, set[str]]]:
    references: list[Reference] = []
    anchors: dict[Path, set[str]] = {}
    for path in sorted(root.rglob("*.html")):
        if not is_public_file(path, root):
            continue
        parser = ReferenceParser(path)
        parser.feed(path.read_text(encoding="utf-8"))
        parser.close()
        references.extend(parser.references)
        anchors[path.resolve()] = parser.anchors
    return references, anchors


def collect_css(root: Path) -> list[Reference]:
    references: list[Reference] = []
    for path in sorted(root.rglob("*.css")):
        if not is_public_file(path, root):
            continue
        text = path.read_text(encoding="utf-8")
        for pattern in (CSS_URL_RE, CSS_IMPORT_RE):
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                references.append(Reference(path, match.group(2), line))
    return references


def collect_javascript(root: Path) -> list[Reference]:
    references: list[Reference] = []
    for path in sorted(root.rglob("*.js")):
        if not is_public_file(path, root):
            continue
        text = path.read_text(encoding="utf-8")
        for match in ROOT_FETCH_RE.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            references.append(Reference(path, match.group(2), line))
    return references


def resolve_reference(reference: Reference, root: Path) -> tuple[Path | None, str]:
    value = reference.value.strip()
    if not value or value.startswith("//") or "{{" in value or "${" in value:
        return None, ""
    parsed = urlsplit(value)
    if parsed.scheme.lower() in SKIPPED_SCHEMES or parsed.netloc:
        return None, ""

    raw_path = unquote(parsed.path)
    if raw_path:
        if raw_path.startswith("/"):
            target = root / raw_path.lstrip("/")
        else:
            target = reference.source.parent / raw_path
    else:
        target = reference.source

    try:
        target = target.resolve()
        target.relative_to(root)
    except ValueError:
        return target, parsed.fragment

    if target.is_dir() or raw_path.endswith("/"):
        target /= "index.html"
    return target, unquote(parsed.fragment)


def validate(root: Path) -> tuple[int, list[str]]:
    root = root.resolve()
    html_references, anchors = collect_html(root)
    references = html_references + collect_css(root) + collect_javascript(root)
    errors: list[str] = []

    for reference in references:
        target, fragment = resolve_reference(reference, root)
        if target is None:
            continue
        label = f"{reference.source.relative_to(root)}:{reference.line}"
        try:
            target.relative_to(root)
        except ValueError:
            errors.append(f"{label}: local reference escapes repository root: {reference.value}")
            continue
        if not target.is_file():
            errors.append(f"{label}: missing local target: {reference.value} -> {target.relative_to(root)}")
            continue
        if fragment and target.suffix.lower() == ".html":
            target_key = target.resolve()
            target_anchors = anchors.get(target_key)
            if target_anchors is None:
                parser = ReferenceParser(target)
                parser.feed(target.read_text(encoding="utf-8"))
                parser.close()
                target_anchors = parser.anchors
                anchors[target_key] = target_anchors
            if fragment not in target_anchors:
                errors.append(
                    f"{label}: missing fragment #{fragment} in {target.relative_to(root)}"
                )
    return len(references), errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", nargs="?", default=".", type=Path)
    args = parser.parse_args(argv)
    if not args.repo.is_dir():
        parser.error(f"repository root does not exist: {args.repo}")

    count, errors = validate(args.repo)
    if errors:
        print("Local reference check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"Local reference check passed: {count} references validated")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
