#!/usr/bin/env python3
"""Validate the eight public team cards and their release evidence."""

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


NEW_NAMES = {
    "Александр Золотухин": "Директор по развитию",
    "Евгений Жалнин": "Операционный директор",
    "Дмитрий Цветков": "Коммерческий директор",
    "Дмитрий Благочевский": "Исполнительный директор",
    "Роман Водянов": "Руководитель проектов",
    "Иван Рябоконь": "Менеджер проектов",
}
RETAINED = {
    "Сергей Бешенцев": (
        "Руководитель проекта «Умное окно»",
        "img/team/beshentsev.jpg",
        "4e60d8339bc4989be4d67fa4b7bee57a3794a72744c60a36b971cc8007e68939",
    ),
    "Оксана Скопина": (
        "Главный бухгалтер",
        "img/team/skopina.jpg",
        "9c6fd867ddef00c97ad5e5b4b80ea5cd0df5922350d57639eca04c0ce381ec5f",
    ),
}
EXPECTED_ROLES = {**NEW_NAMES, **{name: values[0] for name, values in RETAINED.items()}}
EXPECTED_RAW_HASHES = {
    "Александр Золотухин": "8f9d0347785f14b835402e3bdbbcc33aece695a608d38f51407229792f223495",
    "Евгений Жалнин": "06c01a9b7a0c71a0a2e925d62cd8c385b30fcfe3c0c0c64440f64797af3d84a2",
    "Дмитрий Цветков": "5ef6b0cb2d82048b8aa16a2a0dd976368513db3eecf8907fa2434b427983195f",
    "Дмитрий Благочевский": "a6d8e581e383405b7518abec1857fd5173286d0009792dd42a0318735b9719e1",
    "Роман Водянов": "31193578a5606a387ed25d233df93b8279c6490ffb307c7a06be96db6ca8d8e3",
    "Иван Рябоконь": "c70027ac4b2ea0c56acdc2de719940c8ce11223fbb35fbc66a7c8fc3c473bb2c",
}
REPLACED_V227_HASHES = {
    "81f5ab7545405426dd55e62ae6840c596979b60146a11a45b7a7fa1e7d349785",
    "111c2ba0c42d6a338e284f72889672713a138e331107f6dae16414a1359fabc3",
    "035e1eecaeecb212d683ce6d9ef69839293ee0e096aca081a585ce2b1efef5fb",
    "7a1eace5c4c19be4d30a06925c8f8be795c041b8f318e1fffe9a0a9460839fc5",
    "374f36d69a8f0124568c1f0cfe9b1e01a337366ad67eee2c7994412246b20dc4",
    "1940b57fb09df9c3bfabbad631b2f35a1fbd1179b0b791575b502a81257bc4be",
}
FORBIDDEN_ROLE = "Генеральный директор"
MAX_COMBINED_BYTES = 900_000


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


def validate_image(path: Path, expected_format: str, expected_hash: str) -> list[str]:
    errors: list[str] = []
    if not path.is_file():
        return [f"missing portrait output: {path}"]
    if sha256(path) != expected_hash:
        errors.append(f"portrait hash mismatch: {path}")
    try:
        with Image.open(path) as image:
            if image.format != expected_format or image.size != (800, 1000):
                errors.append(f"unexpected portrait encoding: {path} ({image.format}, {image.size})")
            if image.getexif():
                errors.append(f"EXIF metadata must be absent: {path}")
    except OSError as error:
        errors.append(f"cannot decode portrait {path}: {error}")
    return errors


def validate(index_path: Path, evidence_path: Path, repo: Path) -> list[str]:
    errors: list[str] = []
    html = index_path.read_text(encoding="utf-8")
    if FORBIDDEN_ROLE in html:
        errors.append(f"forbidden legacy role remains in {index_path}")
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
    if len(cards) != 8:
        errors.append(f"expected eight team cards, found {len(cards)}")

    dom: dict[str, dict[str, Any]] = {}
    for card in cards:
        headings = descendants(card, "h3")
        roles = descendants(card, "strong")
        images = descendants(card, "img")
        sources = descendants(card, "source")
        if len(headings) != 1 or len(roles) != 1 or len(images) != 1:
            errors.append("each team card must have exactly one h3, strong role and img")
            continue
        name = text_content(headings[0])
        if name in dom:
            errors.append(f"duplicate team card: {name}")
        dom[name] = {"role": text_content(roles[0]), "img": images[0].attrs, "sources": sources}

    if set(dom) != set(EXPECTED_ROLES):
        errors.append(f"team names differ: expected {sorted(EXPECTED_ROLES)}, got {sorted(dom)}")
    for name, expected_role in EXPECTED_ROLES.items():
        if name in dom and dom[name]["role"] != expected_role:
            errors.append(f"wrong role for {name}: {dom[name]['role']!r}")

    manifest = json.loads(evidence_path.read_text(encoding="utf-8"))
    if manifest.get("portrait_count") != 8 or manifest.get("new_portrait_count") != 6 or manifest.get("retained_portrait_count") != 2:
        errors.append("manifest portrait counts must be 8/6/2")
    approval = manifest.get("approval", {})
    if approval.get("approver") != "Саня" or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", approval.get("approved_at", "")):
        errors.append("manifest needs the approver and an ISO-8601 approval timestamp")
    if manifest.get("web_use_rights", {}).get("confirmed") is not True:
        errors.append("internal web-use rights confirmation is missing")

    records = manifest.get("portraits", [])
    by_name = {record.get("name"): record for record in records}
    if len(records) != 8 or set(by_name) != set(EXPECTED_ROLES):
        errors.append("manifest must contain eight unique expected people")

    output_paths: set[str] = set()
    output_hashes: set[str] = set()
    public_webp_hashes: set[str] = set()
    combined_bytes = 0
    for name, role in NEW_NAMES.items():
        record = by_name.get(name, {})
        if record.get("status") != "approved_new_shoot" or record.get("role") != role:
            errors.append(f"invalid new-shoot evidence for {name}")
            continue
        if record.get("raw", {}).get("sha256") != EXPECTED_RAW_HASHES[name]:
            errors.append(f"approved raw hash mismatch for {name}")
        raw_path = repo / record.get("raw", {}).get("path", "")
        if raw_path.is_file() and sha256(raw_path) != EXPECTED_RAW_HASHES[name]:
            errors.append(f"approved raw file changed for {name}")
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
        webp = outputs.get("webp", {})
        if webp.get("sha256"):
            public_webp_hashes.add(webp["sha256"])
        if image.get("src") != jpeg.get("path"):
            errors.append(f"JPEG src does not match evidence for {name}")
        sources = dom.get(name, {}).get("sources", [])
        if len(sources) != 1 or sources[0].attrs.get("srcset") != webp.get("path") or sources[0].attrs.get("type") != "image/webp":
            errors.append(f"WebP source does not match evidence for {name}")
        for format_name, output, expected_format in (("jpeg", jpeg, "JPEG"), ("webp", webp, "WEBP")):
            path_value = output.get("path", "")
            digest = output.get("sha256", "")
            if not re.fullmatch(r"img/team/[a-z0-9-]+-2026-07\.(?:jpg|webp)", path_value):
                errors.append(f"unversioned {format_name} output for {name}: {path_value}")
                continue
            if path_value in output_paths or digest in output_hashes:
                errors.append(f"duplicate output path/hash for {name}")
            output_paths.add(path_value)
            output_hashes.add(digest)
            path = repo / path_value
            errors.extend(validate_image(path, expected_format, digest))
            if path.is_file():
                combined_bytes += path.stat().st_size
                if output.get("bytes") != path.stat().st_size:
                    errors.append(f"recorded byte size mismatch: {path_value}")

    for name, (role, path_value, expected_hash) in RETAINED.items():
        record = by_name.get(name, {})
        image = dom.get(name, {}).get("img", {})
        if image.get("src") != path_value:
            errors.append(f"retained src changed for {name}")
        path = repo / path_value
        if not path.is_file() or sha256(path) != expected_hash:
            errors.append(f"retained portrait hash changed for {name}")
        if record.get("status") != "retained_v227_unchanged" or record.get("current_sha256") != expected_hash or record.get("baseline_sha256") != expected_hash or record.get("role") != role:
            errors.append(f"retained evidence mismatch for {name}")

    if combined_bytes > MAX_COMBINED_BYTES:
        errors.append(f"combined new JPEG/WebP size exceeds 900 KB: {combined_bytes}")
    if manifest.get("new_outputs_combined_bytes") != combined_bytes:
        errors.append("manifest combined byte size does not match files")
    if len(output_hashes) != 12:
        errors.append(f"expected twelve unique encoded output hashes, found {len(output_hashes)}")
    if len(public_webp_hashes) != 6 or public_webp_hashes & REPLACED_V227_HASHES:
        errors.append("expected six unique public portrait hashes distinct from V2.27")

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
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("index", nargs="?", type=Path, default=Path("index.html"))
    parser.add_argument("evidence", nargs="?", type=Path, default=Path("release-evidence/team-release-evidence.json"))
    parser.add_argument("--repo", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    errors = validate(args.index.resolve(), args.evidence.resolve(), args.repo.resolve())
    if errors:
        print("Team DOM/manifest check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Team DOM/manifest check passed: 8 unique cards, 6 approved replacements, 2 unchanged portraits")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
