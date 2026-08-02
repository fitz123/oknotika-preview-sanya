#!/usr/bin/env python3
"""Validate the nine-card team grid, portrait derivatives and review evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from PIL import Image


EXPECTED_ORDER = [
    "Александр Золотухин",
    "Алексей Макаров",
    "Дмитрий Благочевский",
    "Роман Водянов",
    "Иван Рябоконь",
    "Андрей Свирида",
    "Оксана Скопина",
    "Ирина Благочевская",
    "Екатерина Рычкова",
]
EXPECTED_ROLES = {
    "Александр Золотухин": "Руководитель компании · директор по развитию",
    "Алексей Макаров": "Генеральный директор",
    "Дмитрий Благочевский": "Исполнительный директор",
    "Роман Водянов": "Руководитель проектов",
    "Иван Рябоконь": "Руководитель направления «Умное окно»",
    "Андрей Свирида": "Директор медианаправления",
    "Оксана Скопина": "Главный бухгалтер",
    "Ирина Благочевская": "Менеджер тендерного отдела",
    "Екатерина Рычкова": "Исполнительный бухгалтер",
}
EXPECTED_RAW_HASHES = {
    "Алексей Макаров": "da3350710ddde0d77a60dffdc183b22871fa1925d7ce65387f88ca6ae11bb877",
    "Андрей Свирида": "298182d3ea8ae44d5d65cfa5267d60b340b82103146c278c9e5af2af7e4081e1",
    "Оксана Скопина": "e2181428ee5bc2346ea7249db6e52067a1900d7ae53952b199556b5ead6e70b2",
    "Екатерина Рычкова": "0ea182fb44ebeb6d761f2d9e1d8ef1e0d743960b08493c95143f8c5124c94076",
}
OUTPUT_SIZE = (800, 1000)


@dataclass
class Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list["Node | str"] = field(default_factory=list)
    parent: "Node | None" = None


class Parser(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.current = self.root

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag, {key: value or "" for key, value in attrs}, parent=self.current)
        self.current.children.append(node)
        if tag not in self.VOID:
            self.current = node

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        cursor: Node | None = self.current
        while cursor and cursor is not self.root:
            if cursor.tag == tag:
                self.current = cursor.parent or self.root
                return
            cursor = cursor.parent

    def handle_data(self, data: str) -> None:
        value = " ".join(data.split())
        if value:
            self.current.children.append(value)


def descendants(node: Node, tag: str | None = None) -> list[Node]:
    found: list[Node] = []
    for child in node.children:
        if isinstance(child, str):
            continue
        if tag is None or child.tag == tag:
            found.append(child)
        found.extend(descendants(child, tag))
    return found


def text_content(node: Node) -> str:
    values: list[str] = []
    for child in node.children:
        values.append(child if isinstance(child, str) else text_content(child))
    return " ".join(value for value in values if value).strip()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_layout(css: str) -> list[str]:
    errors: list[str] = []
    base_rules = re.findall(r"\.team-grid\s*\{([^{}]+)\}", css)
    if not base_rules or "grid-template-columns: repeat(3, 1fr)" not in base_rules[0]:
        errors.append("team grid must default to three columns")
    mobile_blocks = re.findall(r"@media\s*\(max-width:\s*(\d+)px\)\s*\{(.*?)\n\}", css, re.DOTALL)
    mobile_one_column = False
    for width, block in mobile_blocks:
        if int(width) <= 640 and re.search(r"[^\n{]*\.team-grid[^\n{]*\{[^{}]*grid-template-columns:\s*1fr", block):
            mobile_one_column = True
            break
    if not mobile_one_column:
        errors.append("team grid needs a one-column mobile rule at 640 px or below")
    for width, block in mobile_blocks:
        if int(width) > 640 and re.search(r"[^\n{]*\.team-grid[^\n{]*\{[^{}]*grid-template-columns:\s*1fr", block):
            errors.append("tablet team grid must remain three columns")
            break
    required_portrait_rules = (
        r"\.person__portrait\s*\{[^{}]*aspect-ratio:\s*4\s*/\s*5",
        r"\.person__portrait img\s*\{[^{}]*height:\s*100%",
        r"\.person__portrait img\s*\{[^{}]*object-fit:\s*cover",
    )
    if any(not re.search(pattern, css) for pattern in required_portrait_rules):
        errors.append("portrait boxes must be 4:5 with object-fit cover and fixed box height")
    return errors


def validate_image(path: Path, expected_format: str, expected_hash: str) -> list[str]:
    errors: list[str] = []
    if not path.is_file():
        return [f"missing portrait output: {path}"]
    if sha256(path) != expected_hash:
        errors.append(f"portrait hash mismatch: {path}")
    try:
        with Image.open(path) as image:
            if image.format != expected_format or image.size != OUTPUT_SIZE:
                errors.append(f"unexpected portrait encoding: {path} ({image.format}, {image.size})")
            if image.getexif():
                errors.append(f"EXIF metadata must be absent: {path}")
    except OSError as error:
        errors.append(f"cannot decode portrait {path}: {error}")
    return errors


def validate(
    index_path: Path,
    evidence_path: Path,
    repo: Path,
    style_path: Path | None = None,
) -> list[str]:
    errors: list[str] = []
    html = index_path.read_text(encoding="utf-8")
    parser = Parser()
    parser.feed(html)
    sections = [node for node in descendants(parser.root, "section") if node.attrs.get("id") == "team"]
    if len(sections) != 1:
        return [f"expected one #team section, found {len(sections)}"]
    cards = [
        node
        for node in descendants(sections[0], "article")
        if "person" in node.attrs.get("class", "").split()
    ]
    if len(cards) != 9:
        errors.append(f"expected nine team cards, found {len(cards)}")

    dom: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for card in cards:
        headings = descendants(card, "h3")
        roles = descendants(card, "strong")
        images = descendants(card, "img")
        pictures = [node for node in descendants(card, "picture") if "person__portrait" in node.attrs.get("class", "").split()]
        sources = descendants(card, "source")
        if len(headings) != 1 or len(roles) != 1 or len(images) != 1 or len(pictures) != 1:
            errors.append("each team card must have one h3, strong role, img and person__portrait picture")
            continue
        name = text_content(headings[0])
        order.append(name)
        if name in dom:
            errors.append(f"duplicate team card: {name}")
        dom[name] = {"role": text_content(roles[0]), "img": images[0].attrs, "sources": sources}

    if order != EXPECTED_ORDER:
        errors.append(f"wrong team order: expected {EXPECTED_ORDER}, got {order}")
    if set(dom) != set(EXPECTED_ROLES):
        errors.append(f"team names differ: expected {sorted(EXPECTED_ROLES)}, got {sorted(dom)}")
    for name, expected_role in EXPECTED_ROLES.items():
        if name in dom and dom[name]["role"] != expected_role:
            errors.append(f"wrong role for {name}: {dom[name]['role']!r}")
    if descendants(sections[0], "div") and "person__placeholder" in html:
        errors.append("team portrait placeholder remains")

    manifest = json.loads(evidence_path.read_text(encoding="utf-8"))
    if (
        manifest.get("portrait_count") != 9
        or manifest.get("task_media_portrait_count") != 4
        or manifest.get("retained_portrait_count") != 5
    ):
        errors.append("manifest portrait counts must be 9/4/5")
    approval = manifest.get("approval", {})
    if (
        approval.get("approver") != "Саня"
        or approval.get("scope") != "review-only preview"
        or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", approval.get("approved_on", ""))
    ):
        errors.append("manifest needs the task approval timestamp and review-only scope")

    records = manifest.get("portraits", [])
    by_name = {record.get("name"): record for record in records}
    if len(records) != 9 or set(by_name) != set(EXPECTED_ROLES):
        errors.append("manifest must contain nine unique expected people")

    output_paths: set[str] = set()
    output_hashes: set[str] = set()
    new_bytes = 0
    for name in EXPECTED_ORDER:
        record = by_name.get(name, {})
        if record.get("role") != EXPECTED_ROLES[name]:
            errors.append(f"evidence role mismatch for {name}")
        is_task_media = name in EXPECTED_RAW_HASHES
        expected_status = "approved_task_media" if is_task_media else "retained_approved_derivative"
        if record.get("status") != expected_status:
            errors.append(f"wrong evidence status for {name}")
        if is_task_media:
            if record.get("raw", {}).get("sha256") != EXPECTED_RAW_HASHES[name]:
                errors.append(f"approved raw hash mismatch for {name}")
            crop = record.get("crop", {})
            if crop.get("width", 0) * 5 != crop.get("height", 0) * 4:
                errors.append(f"crop is not 4:5 for {name}")
            eye_line = crop.get("eye_line_output_ratio", 0)
            if not 0.20 <= eye_line <= 0.30:
                errors.append(f"eye line is outside the normalized band for {name}: {eye_line}")
            if record.get("approval", {}).get("approver") != "Саня":
                errors.append(f"portrait approval is missing for {name}")

        image = dom.get(name, {}).get("img", {})
        expected_html = record.get("html", {})
        for attribute in ("alt", "width", "height", "loading", "decoding"):
            if image.get(attribute) != str(expected_html.get(attribute)):
                errors.append(f"wrong {attribute} for {name}")
        outputs = record.get("outputs", {})
        jpeg = outputs.get("jpeg", {})
        webp = outputs.get("webp")
        if image.get("src") != jpeg.get("path"):
            errors.append(f"JPEG src does not match evidence for {name}")
        sources = dom.get(name, {}).get("sources", [])
        if webp:
            if len(sources) != 1 or sources[0].attrs.get("srcset") != webp.get("path") or sources[0].attrs.get("type") != "image/webp":
                errors.append(f"WebP source does not match evidence for {name}")
        elif sources:
            errors.append(f"unexpected WebP source for {name}")

        for format_name, output in outputs.items():
            expected_format = "JPEG" if format_name == "jpeg" else "WEBP"
            path_value = output.get("path", "")
            digest = output.get("sha256", "")
            if not re.fullmatch(r"img/team/[a-z0-9-]+-2026-(?:07|08)\.(?:jpg|webp)", path_value):
                errors.append(f"unversioned {format_name} output for {name}: {path_value}")
                continue
            if path_value in output_paths or digest in output_hashes:
                errors.append(f"duplicate output path/hash for {name}")
            output_paths.add(path_value)
            output_hashes.add(digest)
            path = repo / path_value
            errors.extend(validate_image(path, expected_format, digest))
            if path.is_file():
                if output.get("bytes") != path.stat().st_size:
                    errors.append(f"recorded byte size mismatch: {path_value}")
                if is_task_media:
                    new_bytes += path.stat().st_size

    if manifest.get("task_media_outputs_combined_bytes") != new_bytes:
        errors.append("manifest task-media byte size does not match files")
    if new_bytes > manifest.get("task_media_outputs_max_bytes", 0):
        errors.append(f"task-media outputs exceed the recorded byte budget: {new_bytes}")

    approval_path = evidence_path.parent / "team-approval/approval-sheet.json"
    if not approval_path.is_file():
        errors.append("responsive approval-sheet manifest is missing")
    else:
        sheet = json.loads(approval_path.read_text(encoding="utf-8"))
        captures = sheet.get("capture", {}).get("screenshots", [])
        if {capture.get("viewport_width") for capture in captures} != {1440, 390}:
            errors.append("approval sheets must cover desktop 1440 px and mobile 390 px")
        for capture in captures:
            path = approval_path.parent / capture.get("filename", "")
            if not path.is_file():
                errors.append(f"approval screenshot is missing: {path}")
                continue
            if sha256(path) != capture.get("sha256") or path.stat().st_size != capture.get("bytes"):
                errors.append(f"approval screenshot reference mismatch: {path}")
            with Image.open(path) as screenshot:
                if screenshot.width != capture.get("width") or screenshot.height != capture.get("height"):
                    errors.append(f"approval screenshot dimensions mismatch: {path}")
            metrics = capture.get("metrics", {})
            expected_columns = 1 if capture.get("viewport_width") == 390 else 3
            if (
                metrics.get("card_count") != 9
                or metrics.get("column_count") != expected_columns
                or metrics.get("scroll_width", 0) > metrics.get("client_width", 0) + 1
                or metrics.get("images_ready") is not True
                or metrics.get("portrait_boxes_are_4_by_5") is not True
            ):
                errors.append(f"invalid recorded layout metrics at {capture.get('viewport_width')} px")

    css_path = style_path or repo / "style.css"
    errors.extend(validate_layout(css_path.read_text(encoding="utf-8")))
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", nargs="?", type=Path, default=Path("."))
    parser.add_argument("evidence", nargs="?", type=Path)
    parser.add_argument("--repo", type=Path)
    args = parser.parse_args(argv)
    target = args.target.resolve()
    if target.is_dir():
        repo = (args.repo or target).resolve()
        index_path = target / "index.html"
        evidence_path = args.evidence or target / "release-evidence/team-release-evidence.json"
    else:
        index_path = target
        repo = (args.repo or Path(".")).resolve()
        evidence_path = args.evidence or repo / "release-evidence/team-release-evidence.json"
    errors = validate(index_path, evidence_path.resolve(), repo)
    if errors:
        print("Team DOM/manifest check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Team DOM/manifest check passed: exact 3x3 order, 4 approved replacements, 5 retained portraits")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
