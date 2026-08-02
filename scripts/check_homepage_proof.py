#!/usr/bin/env python3
"""Validate the homepage glass visual, bounded Rubikon copy, and Yandex embeds."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urlparse


YANDEX_ORGANIZATION_ID = "122138017646"
REVIEWS_WIDGET_URL = f"https://yandex.ru/maps-reviews-widget/{YANDEX_ORGANIZATION_ID}?comments"
MAP_WIDGET_URL = (
    "https://yandex.ru/map-widget/v1/"
    f"?ll=37.647163%2C55.761092&mode=search&oid={YANDEX_ORGANIZATION_ID}&ol=biz&z=17"
)


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
        parts.extend(child.text() for child in self.children)
        return " ".join(" ".join(parts).split())

    def descendants(self, tag: str | None = None) -> list["Node"]:
        result: list[Node] = []
        for child in self.children:
            if tag is None or child.tag == tag:
                result.append(child)
            result.extend(child.descendants(tag))
        return result

    def has_ancestor(self, ancestor: "Node") -> bool:
        node = self.parent
        while node is not None:
            if node is ancestor:
                return True
            node = node.parent
        return False


class PageParser(HTMLParser):
    VOID_TAGS = {
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("__root__", {})
        self.current = self.root

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag.lower(), {key.lower(): value or "" for key, value in attrs}, self.current)
        self.current.children.append(node)
        if node.tag not in self.VOID_TAGS:
            self.current = node

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


def has_safe_new_tab(link: Node) -> bool:
    rel = set(link.attrs.get("rel", "").casefold().split())
    return link.attrs.get("target", "").casefold() == "_blank" and {"noopener", "noreferrer"} <= rel


def validate(homepage_path: Path, image_sources_path: Path) -> list[str]:
    errors: list[str] = []
    if not homepage_path.is_file():
        return [f"homepage is missing: {homepage_path}"]
    if not image_sources_path.is_file():
        return [f"image source registry is missing: {image_sources_path}"]

    page = parse_html(homepage_path)
    all_nodes = page.root.descendants()

    glass_cards = [
        node for node in all_nodes
        if node.tag == "a" and node.attrs.get("href", "").rstrip("/") == "glass"
        and "product-link-card" in node.classes()
    ]
    if len(glass_cards) != 1:
        errors.append(f"homepage must contain one glass product card, found {len(glass_cards)}")
    else:
        images = glass_cards[0].descendants("img")
        if len(images) != 1:
            errors.append(f"glass product card must contain one image, found {len(images)}")
        else:
            image = images[0]
            if image.attrs.get("src") != "img/product-world/glass-art.jpg":
                errors.append("glass product card must use the licensed glass photograph")
            if image.attrs.get("data-asset-id") != "licensed-glass-art":
                errors.append("glass product card misses licensed-photo provenance linkage")
            if image.attrs.get("loading") != "lazy" or image.attrs.get("decoding") != "async":
                errors.append("glass product photograph must use lazy loading and async decoding")
    image_sources = image_sources_path.read_text(encoding="utf-8")
    if "img/product-world/glass-art.jpg" not in image_sources or "Pexels photo 35173072" not in image_sources:
        errors.append("licensed glass photograph is missing from IMAGE_SOURCES.md")

    cases = [node for node in all_nodes if node.attrs.get("id") == "cases"]
    if len(cases) != 1:
        errors.append(f"homepage must contain one cases section, found {len(cases)}")
    else:
        cases_text = cases[0].text().casefold()
        required_case_phrases = {
            "единым центром ответственности": "single responsibility center",
            "команда компании «рубикон»": "Rubikon company team",
            "сергея константиновича лункаша": "Rubikon team lead",
            "постоянный монтажный партнёр": "permanent installation partner",
            "коммерческих, социальных и частных объектах": "partner object scope",
            "не приписываются окнотике": "third-party authorship boundary",
        }
        for phrase, label in required_case_phrases.items():
            if phrase not in cases_text:
                errors.append(f"cases section misses {label}: {phrase}")
        outside_rubikon = [
            node for node in all_nodes
            if node.text_parts and re.search(r"рубикон|лункаш", " ".join(node.text_parts), flags=re.IGNORECASE)
            and node is not cases[0] and not node.has_ancestor(cases[0])
        ]
        if outside_rubikon:
            errors.append("Rubikon/Lunkash public copy must remain bounded to the cases section")

    yandex_sections = [node for node in all_nodes if "data-yandex-proof" in node.attrs]
    if len(yandex_sections) != 1:
        errors.append(f"homepage must contain one Yandex proof section, found {len(yandex_sections)}")
    else:
        yandex = yandex_sections[0]
        iframes = yandex.descendants("iframe")
        iframe_sources = {iframe.attrs.get("src", ""): iframe for iframe in iframes}
        if len(iframes) != 2:
            errors.append(f"Yandex proof must contain two iframes, found {len(iframes)}")
        if set(iframe_sources) != {REVIEWS_WIDGET_URL, MAP_WIDGET_URL}:
            errors.append("Yandex proof must use the exact official reviews and map iframe endpoints")
        for source, iframe in iframe_sources.items():
            if iframe.attrs.get("loading") != "lazy":
                errors.append(f"Yandex iframe must be lazy-loaded: {source}")
            if not iframe.attrs.get("title", "").strip():
                errors.append(f"Yandex iframe must have an accessible title: {source}")
            if "width" in iframe.attrs:
                errors.append(f"Yandex iframe must not use a fixed width attribute: {source}")

        review_links = []
        for link in yandex.descendants("a"):
            parsed = urlparse(link.attrs.get("href", ""))
            query = parse_qs(parsed.query)
            if parsed.hostname == "yandex.ru" and YANDEX_ORGANIZATION_ID in parsed.path and query.get("add-review") == ["true"]:
                review_links.append(link)
        if len(review_links) != 1:
            errors.append(f"Yandex proof must contain one direct add-review link, found {len(review_links)}")
        elif not has_safe_new_tab(review_links[0]):
            errors.append("Yandex add-review link must open safely in a new tab")

        yandex_text = yandex.text().casefold()
        if re.search(r"\b[1-5][.,]\d\b", yandex_text) or re.search(r"\b\d+\s+отзыв", yandex_text):
            errors.append("Yandex proof must not hardcode a rating or review count")

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", nargs="?", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    repo = args.repo.resolve()
    errors = validate(repo / "index.html", repo / "IMAGE_SOURCES.md")
    if errors:
        print("Homepage proof check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Homepage proof check passed: licensed glass, bounded Rubikon copy, and official Yandex embeds")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
