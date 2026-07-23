#!/usr/bin/env python3
"""Validate aluminum-page taxonomy, claims, and published material provenance."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import date
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse


@dataclass
class Node:
    tag: str
    attrs: dict[str, str]
    parent: "Node | None" = None
    children: list["Node"] = field(default_factory=list)
    text_parts: list[str] = field(default_factory=list)

    def classes(self) -> set[str]:
        return set(self.attrs.get("class", "").split())

    def text(self) -> str:
        parts = [*self.text_parts]
        for child in self.children:
            parts.append(child.text())
        return " ".join(" ".join(parts).split())

    def descendants(self, tag: str | None = None) -> list["Node"]:
        result: list[Node] = []
        for child in self.children:
            if tag is None or child.tag == tag:
                result.append(child)
            result.extend(child.descendants(tag))
        return result

    def has_ancestor_attr(self, name: str, value: str) -> bool:
        node: Node | None = self
        while node is not None:
            if node.attrs.get(name) == value:
                return True
            node = node.parent
        return False


class PageParser(HTMLParser):
    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("__root__", {})
        self.current = self.root

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag.lower(), {key.lower(): value or "" for key, value in attrs}, self.current)
        self.current.children.append(node)
        if node.tag not in self.VOID_TAGS:
            self.current = node

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if self.current.tag == tag.lower() and self.current.tag not in self.VOID_TAGS:
            self.current = self.current.parent or self.root

    def handle_endtag(self, tag: str) -> None:
        node: Node | None = self.current
        while node is not None and node is not self.root:
            if node.tag == tag.lower():
                self.current = node.parent or self.root
                return
            node = node.parent

    def handle_data(self, data: str) -> None:
        normalized = " ".join(data.split())
        if normalized:
            self.current.text_parts.append(normalized)


def parse_html(path: Path) -> PageParser:
    parser = PageParser()
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    return parser


def find_class(root: Node, class_name: str) -> list[Node]:
    return [node for node in root.descendants() if class_name in node.classes()]


def heading_texts(node: Node, tag: str = "h3") -> list[str]:
    return [heading.text() for heading in node.descendants(tag)]


def load_provenance(path: Path) -> dict[str, object]:
    text = path.read_text(encoding="utf-8")
    match = re.search(
        r"<!-- BEGIN ALUMINUM_PROVENANCE_JSON -->\s*```json\s*(.*?)\s*```\s*<!-- END ALUMINUM_PROVENANCE_JSON -->",
        text,
        flags=re.DOTALL,
    )
    if not match:
        raise ValueError("machine-readable aluminum provenance block is missing")
    value = json.loads(match.group(1))
    if not isinstance(value, dict):
        raise ValueError("aluminum provenance root must be an object")
    return value


def validate_claims(data: dict[str, object], page: PageParser) -> tuple[dict[str, dict[str, object]], list[str]]:
    errors: list[str] = []
    raw_claims = data.get("claims")
    if not isinstance(raw_claims, list):
        return {}, ["provenance claims must be an array"]
    claims: dict[str, dict[str, object]] = {}
    required = {"id", "source_title", "publisher", "url", "retrieved_at", "license_or_use", "supported_claims", "published_locations"}
    for index, raw_claim in enumerate(raw_claims):
        if not isinstance(raw_claim, dict):
            errors.append(f"claim {index} must be an object")
            continue
        missing = sorted(key for key in required if not raw_claim.get(key))
        if missing:
            errors.append(f"claim {index} misses {missing}")
            continue
        claim_id = str(raw_claim["id"])
        if claim_id in claims:
            errors.append(f"duplicate claim id: {claim_id}")
        claims[claim_id] = raw_claim
        parsed = urlparse(str(raw_claim["url"]))
        if parsed.scheme != "https" or parsed.hostname != "www.schueco.com":
            errors.append(f"claim {claim_id} must use an official https://www.schueco.com source")
        try:
            date.fromisoformat(str(raw_claim["retrieved_at"]))
        except ValueError:
            errors.append(f"claim {claim_id} has an invalid retrieval date")
        if not isinstance(raw_claim["supported_claims"], list) or not raw_claim["supported_claims"]:
            errors.append(f"claim {claim_id} has no supported claims")
        if not isinstance(raw_claim["published_locations"], list) or not raw_claim["published_locations"]:
            errors.append(f"claim {claim_id} has no published locations")

    referenced: set[str] = set()
    for node in page.root.descendants():
        referenced.update(node.attrs.get("data-source-id", "").split())
    unknown = sorted(referenced - set(claims))
    unused = sorted(set(claims) - referenced)
    if unknown:
        errors.append(f"HTML references undocumented claim ids: {unknown}")
    if unused:
        errors.append(f"provenance claims are not connected to HTML: {unused}")
    return claims, errors


def validate_materials(
    data: dict[str, object],
    page: PageParser,
    repo: Path,
    image_sources: Path,
) -> list[str]:
    errors: list[str] = []
    raw_materials = data.get("materials")
    if not isinstance(raw_materials, list):
        return ["provenance materials must be an array"]
    materials: dict[str, dict[str, object]] = {}
    required = {"id", "path", "sha256", "created_at", "source", "license", "purpose"}
    for index, raw_material in enumerate(raw_materials):
        if not isinstance(raw_material, dict):
            errors.append(f"material {index} must be an object")
            continue
        missing = sorted(key for key in required if not raw_material.get(key))
        if missing:
            errors.append(f"material {index} misses {missing}")
            continue
        material_id = str(raw_material["id"])
        if material_id in materials:
            errors.append(f"duplicate material id: {material_id}")
        materials[material_id] = raw_material
        path = repo / str(raw_material["path"])
        if not path.is_file():
            errors.append(f"material is missing: {path.relative_to(repo)}")
            continue
        content = path.read_bytes()
        if content[:4] != b"RIFF" or content[8:12] != b"WEBP":
            errors.append(f"material is not a WebP file: {path.relative_to(repo)}")
        digest = hashlib.sha256(content).hexdigest()
        if digest != raw_material["sha256"]:
            errors.append(f"material hash mismatch: {path.relative_to(repo)}")
        if raw_material.get("third_party_content") is not False:
            errors.append(f"material must explicitly exclude third-party content: {material_id}")
        try:
            date.fromisoformat(str(raw_material["created_at"]))
        except ValueError:
            errors.append(f"material {material_id} has an invalid creation date")

    published_paths = {
        path.relative_to(repo).as_posix()
        for path in (repo / "img/aluminum").glob("schueco-*.webp")
    }
    documented_paths = {str(material["path"]) for material in materials.values()}
    if published_paths != documented_paths:
        errors.append(
            f"published/documented Schüco material mismatch: published={sorted(published_paths)}, documented={sorted(documented_paths)}"
        )
    asset_ids = {node.attrs["data-asset-id"] for node in page.root.descendants() if node.attrs.get("data-asset-id")}
    if asset_ids != set(materials):
        errors.append(f"HTML/material id mismatch: html={sorted(asset_ids)}, documented={sorted(materials)}")

    image_source_text = image_sources.read_text(encoding="utf-8") if image_sources.is_file() else ""
    for path in sorted(documented_paths):
        if f"`{path}`" not in image_source_text:
            errors.append(f"IMAGE_SOURCES.md misses {path}")
    return errors


def validate_page(page: PageParser, homepage: PageParser) -> list[str]:
    errors: list[str] = []
    taxonomy = find_class(page.root, "aluminum-systems")
    expected_taxonomy = [
        "АЛРОКС · СИАЛ · ТАТПРОФ",
        "АЛЮТЕХ · Алюмарк",
        "Schüco",
        "Reynaers · ALUPORT · Keller",
    ]
    if len(taxonomy) != 1:
        errors.append("aluminum taxonomy section must occur exactly once")
    elif heading_texts(taxonomy[0]) != expected_taxonomy:
        errors.append(f"aluminum taxonomy order changed: {heading_texts(taxonomy[0])}")

    hero = find_class(page.root, "schueco-hero")
    hero_headings = heading_texts(hero[0], "h2") if len(hero) == 1 else []
    if hero_headings != ["Schüco — отдельная системная философия фасада"]:
        errors.append("independent Schüco facade focus heading is missing or changed")

    scenarios = find_class(page.root, "facade-scenarios")
    expected_scenarios = ["FWS 50", "FWS 35 PD", "FWS 60 CV", "AF UDC 80 / 80 CV"]
    if len(scenarios) != 1 or heading_texts(scenarios[0]) != expected_scenarios:
        actual = heading_texts(scenarios[0]) if len(scenarios) == 1 else []
        errors.append(f"four Schüco facade scenarios are missing or reordered: {actual}")

    integration = find_class(page.root, "integration-shell")
    integration_text = integration[0].text().casefold() if len(integration) == 1 else ""
    for term in ("окна", "двери", "раздвижные элементы", "солнцезащита", "вентиляция", "автоматика"):
        if term not in integration_text:
            errors.append(f"integrated shell misses {term}")
    if "только в совместимых конфигурациях" not in integration_text:
        errors.append("integrated shell must limit functions to compatible configurations")

    design_path = find_class(page.root, "design-path")
    design_text = design_path[0].text().casefold() if len(design_path) == 1 else ""
    for term in ("фасадная сетка", "функции оболочки", "системный сценарий", "совместимость", "расчёт и узел", "проверяемый выпуск"):
        if term not in design_text:
            errors.append(f"design path misses {term}")

    caveat = find_class(page.root, "facade-caveat")
    caveat_text = caveat[0].text().casefold() if len(caveat) == 1 else ""
    for term in ("доступность", "сертификация", "соответствие местным нормам", "конкретного объекта"):
        if term not in caveat_text:
            errors.append(f"object availability/compliance caveat misses {term}")

    full_text = page.root.text().casefold()
    forbidden_patterns = {
        r"официальн\w*\s+(?:партн[её]р|дилер)": "official partnership/dealership claim",
        r"авторизованн\w*\s+(?:партн[её]р|дилер)": "authorised partnership/dealership claim",
        r"скрыт\w*\s+дренаж\w*\s+(?:во\s+всех|у\s+всех|для\s+всех)": "generalised concealed-drainage claim",
    }
    for pattern, label in forbidden_patterns.items():
        if re.search(pattern, full_text):
            errors.append(f"forbidden public claim: {label}")

    drainage_nodes = [node for node in page.root.descendants() if "дренаж" in " ".join(node.text_parts).casefold()]
    if len(drainage_nodes) != 1:
        errors.append(f"concealed drainage must occur once in the page, found {len(drainage_nodes)}")
    elif not drainage_nodes[0].has_ancestor_attr("data-claim-scope", "aws-75-pd-si"):
        errors.append("concealed drainage escaped the AWS 75 PD.SI claim scope")
    elif "aws 75 pd.si" not in " ".join(drainage_nodes[0].text_parts).casefold():
        errors.append("concealed drainage scope must name AWS 75 PD.SI")

    for image in page.root.descendants("img"):
        source = image.attrs.get("src", "")
        if source.startswith(("http://", "https://")) or "schueco.com" in source.casefold():
            errors.append(f"external or Schüco-hosted media is forbidden: {source}")

    aluminum_cards = [
        node
        for node in homepage.root.descendants("a")
        if node.attrs.get("href") == "aluminum/" and node.descendants("img")
    ]
    if len(aluminum_cards) != 1:
        errors.append("homepage aluminum product card is missing or duplicated")
    else:
        card = aluminum_cards[0]
        image = card.descendants("img")[0]
        if image.attrs.get("src") != "img/aluminum/schueco-facade-grid.webp":
            errors.append("homepage aluminum card does not use the original facade visual")
        if "авторская" not in image.attrs.get("alt", "").casefold():
            errors.append("homepage aluminum card must identify its visual as original")
        if "schüco" not in card.text().casefold():
            errors.append("homepage aluminum card does not expose the Schüco focus")
    return errors


def validate(
    sources_path: Path,
    html_path: Path,
    repo: Path | None = None,
    image_sources: Path | None = None,
    homepage: Path | None = None,
) -> list[str]:
    repo = (repo or html_path.resolve().parents[1]).resolve()
    image_sources = image_sources or repo / "IMAGE_SOURCES.md"
    homepage = homepage or repo / "index.html"
    page = parse_html(html_path)
    home = parse_html(homepage)
    data = load_provenance(sources_path)
    errors = validate_page(page, home)
    _claims, claim_errors = validate_claims(data, page)
    errors.extend(claim_errors)
    errors.extend(validate_materials(data, page, repo, image_sources))
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", type=Path)
    parser.add_argument("html", type=Path)
    args = parser.parse_args(argv)
    try:
        errors = validate(args.sources.resolve(), args.html.resolve())
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Aluminum source check failed: {exc}", file=sys.stderr)
        return 1
    if errors:
        print("Aluminum source check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Aluminum source check passed: 4 scenarios, 5 claim records, 2 original materials")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
