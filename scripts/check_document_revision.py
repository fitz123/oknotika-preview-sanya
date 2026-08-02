#!/usr/bin/env python3
"""Validate the document-revision offer, presentation, and claim boundaries."""

from __future__ import annotations

import argparse
import re
import sys
from html.parser import HTMLParser
from pathlib import Path


class Markup(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: set[str] = set()
        self.links: list[dict[str, str]] = []
        self.slide_count = 0
        self.teaser_count = 0
        self.text_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): value or "" for name, value in attrs}
        if values.get("id"):
            self.ids.add(values["id"])
        classes = values.get("class", "").split()
        if "revision-slide" in classes:
            self.slide_count += 1
        if tag == "section" and "data-document-revision-teaser" in values:
            self.teaser_count += 1
        if tag == "a":
            self.links.append(values)

    def handle_data(self, data: str) -> None:
        self.text_parts.append(data)

    @property
    def text(self) -> str:
        return " ".join(" ".join(self.text_parts).split()).casefold()


def parse(path: Path) -> Markup:
    parser = Markup()
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    return parser


def has_new_tab_contract(link: dict[str, str]) -> bool:
    rel = set(link.get("rel", "").casefold().split())
    return link.get("target", "").casefold() == "_blank" and {"noopener", "noreferrer"} <= rel


def validate(aluminum_path: Path, presentation_path: Path) -> list[str]:
    errors: list[str] = []
    if not aluminum_path.is_file():
        errors.append(f"missing aluminum page: {aluminum_path}")
        return errors
    if not presentation_path.is_file():
        errors.append(f"missing document-revision presentation: {presentation_path}")
        return errors

    aluminum = parse(aluminum_path)
    presentation = parse(presentation_path)

    if aluminum.teaser_count != 1:
        errors.append(f"aluminum page must contain one document-revision teaser, found {aluminum.teaser_count}")
    teaser_links = [
        link for link in aluminum.links
        if link.get("href", "").rstrip("/") == "document-revision-check"
    ]
    if len(teaser_links) != 1:
        errors.append(f"teaser must contain one presentation link, found {len(teaser_links)}")
    elif not has_new_tab_contract(teaser_links[0]):
        errors.append("presentation link must open in a new tab with noopener noreferrer")

    required_ids = {"top", "input", "comparison", "deliverable", "boundaries", "terms", "contact"}
    missing_ids = sorted(required_ids - presentation.ids)
    if missing_ids:
        errors.append(f"presentation misses slide anchors: {', '.join(missing_ids)}")
    if presentation.slide_count < 6:
        errors.append(f"presentation must contain at least six slides, found {presentation.slide_count}")

    required_copy = {
        "исходная версия раздела ар": "original architectural-solutions input",
        "изменённая версия раздела ар": "changed architectural-solutions input",
        "до / после": "before/after evidence",
        "реестр изменений": "change register",
        "15 000 ₽": "current price",
        "только если подтверждена фактическая ошибка": "exact refund boundary",
        "решение и приёмка остаются за человеком": "human engineering acceptance",
        "пто, проектировщиком или авторизованным инженером": "authorized human reviewer",
    }
    for phrase, label in required_copy.items():
        if phrase not in presentation.text:
            errors.append(f"presentation misses {label}: {phrase}")

    telegram_links = [
        link for link in presentation.links
        if link.get("href", "").startswith("https://t.me/")
    ]
    if not telegram_links:
        errors.append("presentation misses a direct Telegram CTA")
    elif not any(has_new_tab_contract(link) for link in telegram_links):
        errors.append("Telegram CTA must open safely in a new tab")

    unsafe_patterns = {
        r"(?:выявим|найд[её]м|обнаружим)\s+все\s+(?:ошибки|изменения)": "perfect detection claim",
        r"(?:безошибочн\w*|100\s*%)": "perfect accuracy claim",
        r"(?<!не\s)автоматическ\w*\s+(?:согласован\w*|одобрен\w*|инженерн\w*\s+решен\w*)": "automatic approval claim",
        r"(?:заменим|заменяет|заменит)\s+(?:проектировщика|инженера|пто)": "engineer replacement claim",
        r"(?:дадим|подготовим|выдадим)\s+юридическ\w*\s+заключен\w*": "legal conclusion claim",
        r"возврат\w*.{0,60}(?:при\s+любом\s+несогласии|по\s+требованию)": "unbounded refund claim",
        r"(?:рассчитаем|определим)\s+(?:ваши\s+)?убытки": "loss calculation claim",
    }
    for pattern, label in unsafe_patterns.items():
        if re.search(pattern, presentation.text):
            errors.append(f"presentation contains {label}")

    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", nargs="?", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    repo = args.repo.resolve()
    errors = validate(
        repo / "aluminum/index.html",
        repo / "aluminum/document-revision-check/index.html",
    )
    if errors:
        print("Document-revision check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("Document-revision offer and presentation check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
