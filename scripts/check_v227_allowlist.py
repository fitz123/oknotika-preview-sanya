#!/usr/bin/env python3
"""Guard the V2.27 tree, protected DOM, and protected CSS rules."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable


VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}


def git(repo: Path, *args: str, text: bool = True) -> str | bytes:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=text,
    )
    return result.stdout


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_baseline_file(repo: Path, baseline: str, path: str) -> bytes:
    return git(repo, "show", f"{baseline}:{path}", text=False)  # type: ignore[return-value]


def baseline_entries(repo: Path, baseline: str) -> dict[str, tuple[str, str]]:
    output = git(repo, "ls-tree", "-r", "-z", baseline, text=False)
    entries: dict[str, tuple[str, str]] = {}
    for item in output.split(b"\0"):  # type: ignore[union-attr]
        if not item:
            continue
        metadata, raw_path = item.split(b"\t", 1)
        mode, object_type, object_id = metadata.decode().split()
        if object_type == "blob":
            entries[raw_path.decode()] = (mode, object_id)
    return entries


def current_paths(repo: Path) -> set[str]:
    output = git(
        repo,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        text=False,
    )
    paths: set[str] = set()
    for raw_path in output.split(b"\0"):  # type: ignore[union-attr]
        if not raw_path:
            continue
        path = raw_path.decode()
        full_path = repo / path
        if full_path.exists() or full_path.is_symlink():
            paths.add(path)
    return paths


def current_modes(repo: Path) -> dict[str, str]:
    output = git(repo, "ls-files", "--stage", "-z", text=False)
    modes: dict[str, str] = {}
    for item in output.split(b"\0"):  # type: ignore[union-attr]
        if not item:
            continue
        metadata, raw_path = item.split(b"\t", 1)
        modes[raw_path.decode()] = metadata.decode().split()[0]
    return modes


def path_matches(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


@dataclass
class HtmlNode:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list["HtmlNode | str"] = field(default_factory=list)
    parent: "HtmlNode | None" = None


class TreeParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = HtmlNode("__root__")
        self.current = self.root

    def handle_decl(self, decl: str) -> None:
        self.current.children.append(HtmlNode(f"!{decl.lower()}", parent=self.current))

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = HtmlNode(
            tag.lower(),
            {name.lower(): value or "" for name, value in attrs},
            parent=self.current,
        )
        self.current.children.append(node)
        if node.tag not in VOID_TAGS:
            self.current = node

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if self.current.tag == tag.lower() and self.current.tag not in VOID_TAGS:
            self.current = self.current.parent or self.root

    def handle_endtag(self, tag: str) -> None:
        cursor: HtmlNode | None = self.current
        while cursor is not None and cursor is not self.root:
            if cursor.tag == tag.lower():
                self.current = cursor.parent or self.root
                return
            cursor = cursor.parent

    def handle_data(self, data: str) -> None:
        normalized = " ".join(data.split())
        if normalized:
            self.current.children.append(normalized)


def matcher_applies(node: HtmlNode, matcher: dict[str, Any]) -> bool:
    if matcher.get("tag") and node.tag != matcher["tag"]:
        return False
    if matcher.get("id") and node.attrs.get("id") != matcher["id"]:
        return False
    classes = set(node.attrs.get("class", "").split())
    if not set(matcher.get("classes", [])).issubset(classes):
        return False
    if "class_prefixes" in matcher and not any(
        class_name.startswith(prefix)
        for class_name in classes
        for prefix in matcher["class_prefixes"]
    ):
        return False
    for key, expected in matcher.get("attributes", {}).items():
        if node.attrs.get(key) != expected:
            return False
    for key, prefix in matcher.get("attribute_prefixes", {}).items():
        if not node.attrs.get(key, "").startswith(prefix):
            return False
    ancestor_matcher = matcher.get("ancestor")
    if ancestor_matcher:
        ancestor = node.parent
        while ancestor is not None:
            if matcher_applies(ancestor, ancestor_matcher):
                break
            ancestor = ancestor.parent
        else:
            return False
    return True


def normalize_html(text: str, matchers: list[dict[str, Any]]) -> Any:
    parser = TreeParser()
    parser.feed(text)
    parser.close()

    def serialize(node: HtmlNode) -> Any:
        children: list[Any] = []
        for child in node.children:
            if isinstance(child, str):
                children.append(("text", child))
            elif any(matcher_applies(child, matcher) for matcher in matchers):
                continue
            else:
                children.append(serialize(child))
        return (node.tag, tuple(sorted(node.attrs.items())), tuple(children))

    return serialize(parser.root)


def strip_css_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)


def find_matching_brace(text: str, opening: int) -> int:
    depth = 0
    quote = ""
    escaped = False
    for index in range(opening, len(text)):
        char = text[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = ""
            continue
        if char in {'"', "'"}:
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    raise ValueError("unbalanced CSS braces")


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def css_rules(text: str, context: tuple[str, ...] = ()) -> list[tuple[tuple[str, ...], str, str]]:
    text = strip_css_comments(text)
    rules: list[tuple[tuple[str, ...], str, str]] = []
    cursor = 0
    while cursor < len(text):
        opening = text.find("{", cursor)
        if opening == -1:
            break
        prelude = normalize_space(text[cursor:opening])
        closing = find_matching_brace(text, opening)
        body = text[opening + 1:closing]
        if prelude.startswith(("@media", "@supports", "@layer", "@container")):
            rules.extend(css_rules(body, context + (prelude,)))
        else:
            rules.append((context, prelude, normalize_space(body)))
        cursor = closing + 1
    return rules


def split_selectors(selector: str) -> list[str]:
    result: list[str] = []
    start = 0
    depth = 0
    quote = ""
    escaped = False
    for index, char in enumerate(selector):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = ""
            continue
        if char in {'"', "'"}:
            quote = char
        elif char in "([":
            depth += 1
        elif char in ")]":
            depth = max(0, depth - 1)
        elif char == "," and depth == 0:
            result.append(selector[start:index].strip())
            start = index + 1
    result.append(selector[start:].strip())
    return [item for item in result if item]


def selector_allowed(selector: str, policy: dict[str, Any]) -> bool:
    token_pattern = re.compile(r"([.#])([A-Za-z_][\w-]*)")
    allowed_classes = policy.get("allowed_class_prefixes", [])
    allowed_ids = set(policy.get("allowed_ids", []))
    components = split_selectors(selector)
    if not components:
        return False
    for component in components:
        tokens = token_pattern.findall(component)
        if not any(
            (kind == "." and any(name.startswith(prefix) for prefix in allowed_classes))
            or (kind == "#" and name in allowed_ids)
            for kind, name in tokens
        ):
            return False
    return True


def protected_css_rules(text: str, policy: dict[str, Any]) -> list[tuple[tuple[str, ...], str, str]]:
    return [rule for rule in css_rules(text) if not selector_allowed(rule[1], policy)]


def verify_manifest(repo: Path, baseline: str, entries: dict[str, tuple[str, str]], manifest: Path) -> list[str]:
    errors: list[str] = []
    expected: dict[str, str] = {}
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        digest, path = line.split("  ", 1)
        expected[path] = digest
    if set(expected) != set(entries):
        missing = sorted(set(entries) - set(expected))
        extra = sorted(set(expected) - set(entries))
        if missing:
            errors.append(f"baseline manifest misses {missing}")
        if extra:
            errors.append(f"baseline manifest has extra paths {extra}")
        return errors
    for path in sorted(entries):
        actual = sha256(read_baseline_file(repo, baseline, path))
        if expected[path] != actual:
            errors.append(f"baseline manifest hash mismatch: {path}")
    return errors


def validate(repo: Path, baseline: str, config_path: Path) -> tuple[list[str], list[str]]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    errors: list[str] = []
    baseline_full = str(git(repo, "rev-parse", f"{baseline}^{{commit}}")).strip()
    if baseline_full != config["baseline"]["commit"]:
        errors.append(f"baseline commit must be {config['baseline']['commit']}, got {baseline_full}")
        return [], errors
    tree = str(git(repo, "rev-parse", f"{baseline_full}^{{tree}}")).strip()
    if tree != config["baseline"]["tree"]:
        errors.append(f"baseline tree mismatch: expected {config['baseline']['tree']}, got {tree}")

    base = baseline_entries(repo, baseline_full)
    paths = current_paths(repo)
    modes = current_modes(repo)
    additions = sorted(paths - set(base))
    deletions = sorted(set(base) - paths)
    modifications: list[str] = []
    for path in sorted(paths & set(base)):
        content = (repo / path).read_bytes()
        mode_changed = modes.get(path, base[path][0]) != base[path][0]
        if sha256(content) != sha256(read_baseline_file(repo, baseline_full, path)) or mode_changed:
            modifications.append(path)

    policy = config["paths"]
    for path in additions:
        if not path_matches(path, policy["allow_add"]):
            errors.append(f"unallowlisted added path: {path}")
    for path in modifications:
        if path not in policy["allow_modify"]:
            errors.append(f"unallowlisted modified path: {path}")
    for path in deletions:
        if path not in policy.get("allow_delete", []):
            errors.append(f"baseline path may not be deleted: {path}")

    for path, matchers in config["dom"].items():
        if path not in base or path not in paths:
            continue
        baseline_html = read_baseline_file(repo, baseline_full, path).decode("utf-8")
        current_html = (repo / path).read_text(encoding="utf-8")
        if normalize_html(baseline_html, matchers) != normalize_html(current_html, matchers):
            errors.append(f"protected DOM changed outside page-scoped allowlist: {path}")

    css_policy = config["css"]
    css_path = css_policy["path"]
    if css_path in base and css_path in paths:
        baseline_css = read_baseline_file(repo, baseline_full, css_path).decode("utf-8")
        current_css = (repo / css_path).read_text(encoding="utf-8")
        if protected_css_rules(baseline_css, css_policy) != protected_css_rules(current_css, css_policy):
            errors.append("protected CSS rules changed outside page-scoped selector allowlist")

    manifest = repo / config["baseline"]["tracked_manifest"]
    if not manifest.is_file():
        errors.append(f"baseline manifest is missing: {manifest.relative_to(repo)}")
    else:
        errors.extend(verify_manifest(repo, baseline_full, base, manifest))
    changed = additions + modifications + deletions
    return changed, errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path("."))
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--config", type=Path)
    args = parser.parse_args(argv)
    repo = args.repo.resolve()
    config = args.config or repo / "release-evidence/baseline/v227-allowlist.json"
    try:
        changed, errors = validate(repo, args.baseline, config)
    except (OSError, ValueError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        print(f"V2.27 allowlist check failed: {exc}", file=sys.stderr)
        return 1
    if errors:
        print("V2.27 allowlist check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"V2.27 allowlist check passed: {len(changed)} changed paths are scoped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
