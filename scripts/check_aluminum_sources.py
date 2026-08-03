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
    required = {
        "id",
        "path",
        "sha256",
        "source_sha256",
        "created_at",
        "source",
        "license",
        "purpose",
        "media_type",
        "width",
        "height",
        "published_locations",
        "third_party_content",
    }
    expected_source_hashes = {
        "raluma-portal-interior": "46011b13c5203e64aa1825fbb43a7be9c41f9a30bdffdd880cb1e60fd092e812",
        "raluma-portal-video": "acae8b73fc96279cec467d7f866843d43de5874cc9bcdd5127ce9d4e3b120cf6",
        "raluma-portal-poster": "acae8b73fc96279cec467d7f866843d43de5874cc9bcdd5127ce9d4e3b120cf6",
        "raluma-portal-exterior": "cf1d60d4fb0a76e3979f724c22559b6db8d34e51cf1021d3853c765ec360dda9",
    }
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
        media_type = raw_material["media_type"]
        if media_type == "image/webp" and (content[:4] != b"RIFF" or content[8:12] != b"WEBP"):
            errors.append(f"material is not a WebP file: {path.relative_to(repo)}")
        elif media_type == "image/jpeg" and content[:2] != b"\xff\xd8":
            errors.append(f"material is not a JPEG file: {path.relative_to(repo)}")
        elif media_type == "video/mp4" and (len(content) < 12 or content[4:8] != b"ftyp"):
            errors.append(f"material is not an MP4 file: {path.relative_to(repo)}")
        elif media_type not in {"image/webp", "image/jpeg", "video/mp4"}:
            errors.append(f"material has unsupported media type: {material_id}")
        digest = hashlib.sha256(content).hexdigest()
        if digest != raw_material["sha256"]:
            errors.append(f"material hash mismatch: {path.relative_to(repo)}")
        source_digest = str(raw_material["source_sha256"])
        if not re.fullmatch(r"[0-9a-f]{64}", source_digest):
            errors.append(f"material source hash is invalid: {material_id}")
        expected_source_hash = expected_source_hashes.get(material_id)
        if expected_source_hash and source_digest != expected_source_hash:
            errors.append(f"material source hash does not match the approved input: {material_id}")
        if not isinstance(raw_material.get("third_party_content"), bool):
            errors.append(f"material must declare third-party content: {material_id}")
        if not isinstance(raw_material.get("width"), int) or not isinstance(raw_material.get("height"), int):
            errors.append(f"material dimensions must be positive integers: {material_id}")
        elif int(raw_material["width"]) <= 0 or int(raw_material["height"]) <= 0:
            errors.append(f"material dimensions must be positive integers: {material_id}")
        if not isinstance(raw_material.get("published_locations"), list) or not raw_material["published_locations"]:
            errors.append(f"material has no published locations: {material_id}")
        try:
            date.fromisoformat(str(raw_material["created_at"]))
        except ValueError:
            errors.append(f"material {material_id} has an invalid creation date")
        if material_id == "raluma-portal-video":
            if len(content) > 2_500_000:
                errors.append("RALUMA loop exceeds the 2.5 MB performance boundary")
            if b"soun" in content:
                errors.append("RALUMA loop must not contain an audio track")
            moov_position = content.find(b"moov")
            mdat_position = content.find(b"mdat")
            if moov_position < 0 or mdat_position < 0 or moov_position > mdat_position:
                errors.append("RALUMA loop must use fast-start MP4 ordering")

    expected_material_paths = {
        "licensed-facade-mood": "img/product-world/glass-facade.jpg",
        "licensed-design-path-mood": "img/product-world/glass-art.jpg",
        "raluma-portal-interior": "img/aluminum/raluma-portal-interior.webp",
        "raluma-portal-video": "img/aluminum/raluma-portal-loop.mp4",
        "raluma-portal-poster": "img/aluminum/raluma-portal-poster.webp",
        "raluma-portal-exterior": "img/aluminum/raluma-portal-exterior.webp",
    }
    actual_material_paths = {material_id: str(material["path"]) for material_id, material in materials.items()}
    if actual_material_paths != expected_material_paths:
        errors.append(
            f"approved aluminum media changed: actual={actual_material_paths}, expected={expected_material_paths}"
        )

    legacy_paths = [
        repo / "img/aluminum/schueco-facade-grid.webp",
        repo / "img/aluminum/schueco-design-path.webp",
    ]
    for legacy_path in legacy_paths:
        if legacy_path.exists():
            errors.append(f"removed in-house scheme is still present: {legacy_path.relative_to(repo)}")

    asset_ids = {node.attrs["data-asset-id"] for node in page.root.descendants() if node.attrs.get("data-asset-id")}
    asset_ids.update(
        node.attrs["data-poster-asset-id"]
        for node in page.root.descendants()
        if node.attrs.get("data-poster-asset-id")
    )
    if asset_ids != set(materials):
        errors.append(f"HTML/material id mismatch: html={sorted(asset_ids)}, documented={sorted(materials)}")

    documented_paths = {str(material["path"]) for material in materials.values()}
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
        "UNISTEM · Reynaers · Keller · ALUMIL",
        "Schüco",
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

    design_features = find_class(page.root, "design-path__feature")
    if len(design_features) != 1:
        errors.append("design path must contain one photographic feature")
    else:
        feature_images = design_features[0].descendants("img")
        if len(feature_images) != 1 or feature_images[0].attrs.get("src") != "../img/product-world/glass-art.jpg":
            errors.append("design path does not use its distinct licensed architectural photograph")

    raluma = find_class(page.root, "raluma-feature")
    if len(raluma) != 1:
        errors.append("detailed RALUMA feature must occur exactly once")
    else:
        expected_assets = {"raluma-portal-interior", "raluma-portal-video", "raluma-portal-exterior"}
        actual_assets = {
            node.attrs["data-asset-id"]
            for node in raluma[0].descendants()
            if node.attrs.get("data-asset-id")
        }
        if actual_assets != expected_assets:
            errors.append(f"RALUMA feature uses unexpected media: {sorted(actual_assets)}")
        expected_images = {
            "../img/aluminum/raluma-portal-interior.webp",
            "../img/aluminum/raluma-portal-exterior.webp",
        }
        raluma_images = raluma[0].descendants("img")
        actual_images = {image.attrs.get("src", "") for image in raluma_images}
        if actual_images != expected_images:
            errors.append(f"RALUMA feature uses unexpected photography: {sorted(actual_images)}")
        if any(image.attrs.get("loading") != "lazy" or image.attrs.get("decoding") != "async" for image in raluma_images):
            errors.append("RALUMA photography must use lazy loading and asynchronous decoding")
        videos = raluma[0].descendants("video")
        if len(videos) != 1:
            errors.append("RALUMA feature must contain one video")
        else:
            video = videos[0]
            for attribute in ("autoplay", "muted", "loop", "playsinline"):
                if attribute not in video.attrs:
                    errors.append(f"RALUMA video misses {attribute}")
            if video.attrs.get("preload") != "metadata":
                errors.append("RALUMA video must use metadata preload")
            if video.attrs.get("poster") != "../img/aluminum/raluma-portal-poster.webp":
                errors.append("RALUMA video poster is missing or changed")
            sources = video.descendants("source")
            if len(sources) != 1 or sources[0].attrs.get("src") != "../img/aluminum/raluma-portal-loop.mp4":
                errors.append("RALUMA video source is missing or changed")
            elif sources[0].attrs.get("type") != "video/mp4":
                errors.append("RALUMA video source must declare video/mp4")

    all_nodes = page.root.descendants()
    design_positions = [index for index, node in enumerate(all_nodes) if "design-path" in node.classes()]
    raluma_positions = [index for index, node in enumerate(all_nodes) if "raluma-feature" in node.classes()]
    if design_positions and raluma_positions and raluma_positions[0] <= design_positions[0]:
        errors.append("detailed RALUMA feature must follow the Schüco design path")

    full_text = page.root.text().casefold()
    forbidden_patterns = {
        r"официальн\w*\s+(?:партн[её]р|дилер)": "official partnership/dealership claim",
        r"авторизованн\w*\s+(?:партн[её]р|дилер)": "authorised partnership/dealership claim",
        r"скрыт\w*\s+дренаж\w*\s+(?:во\s+всех|у\s+всех|для\s+всех)": "generalised concealed-drainage claim",
        r"авторская\s+схема": "legacy in-house scheme caption",
        r"черт[её]ж\s+узла": "legacy drawing caption",
        r"изображение\s+продукции\s+schüco": "legacy Schüco-product caption",
        r"объектная\s+проверка": "removed object-check jargon",
        r"система\s*[—-]\s*кандидат": "removed candidate-system jargon",
        r"(?:не\s+)?обещани\w*\s+поставки": "removed supply-promise jargon",
        r"доступност\w*\s+профил": "removed profile-availability jargon",
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
        if "schüco" in image.attrs.get("alt", "").casefold():
            errors.append(f"image alt must not identify mood photography as Schüco media: {source}")

    if page.root.descendants("figcaption"):
        errors.append("aluminum photography must not reintroduce caption clutter")

    hero_images = hero[0].descendants("img") if len(hero) == 1 else []
    if len(hero_images) != 1 or hero_images[0].attrs.get("src") != "../img/product-world/glass-facade.jpg":
        errors.append("Schüco focus does not use the licensed facade photograph")

    html_source = " ".join(
        node.attrs.get(attribute, "")
        for node in page.root.descendants()
        for attribute in ("src", "poster", "style")
    ).casefold()
    for forbidden_asset in ("schueco-facade-grid", "schueco-design-path", "raluma-unused-second"):
        if forbidden_asset in html_source:
            errors.append(f"removed or unapproved visual is still published: {forbidden_asset}")

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
        if image.attrs.get("src") != "img/product-world/glass-facade.jpg":
            errors.append("homepage aluminum card does not use the licensed facade photograph")
        if image.attrs.get("data-asset-id") != "licensed-facade-mood":
            errors.append("homepage aluminum card misses facade-photo provenance linkage")
        if "schüco" in image.attrs.get("alt", "").casefold():
            errors.append("homepage facade-photo alt must not identify it as Schüco media")
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
    parser.add_argument(
        "paths",
        type=Path,
        nargs="*",
        help="repository root, or legacy ALUMINUM_SOURCES.md and aluminum HTML paths",
    )
    args = parser.parse_args(argv)
    if len(args.paths) > 2:
        parser.error("expected a repository root or two explicit source/HTML paths")
    if len(args.paths) <= 1:
        repo = (args.paths[0] if args.paths else Path(".")).resolve()
        sources = repo / "ALUMINUM_SOURCES.md"
        html = repo / "aluminum/index.html"
    else:
        sources, html = (path.resolve() for path in args.paths)
        repo = html.parents[1]
    try:
        errors = validate(sources, html, repo)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Aluminum source check failed: {exc}", file=sys.stderr)
        return 1
    if errors:
        print("Aluminum source check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Aluminum source check passed: 4 scenarios, 5 claim records, and 6 approved media records")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
