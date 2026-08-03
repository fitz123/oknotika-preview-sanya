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
        self.tariff_table_count = 0
        self.tariff_row_count = 0
        self.refund_paragraph_count = 0
        self._in_table_body = False
        self.section_order: list[str] = []
        self.text_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {name.lower(): value or "" for name, value in attrs}
        if values.get("id"):
            self.ids.add(values["id"])
        classes = values.get("class", "").split()
        if "revision-slide" in classes:
            self.slide_count += 1
        if tag == "table":
            self.tariff_table_count += 1
        elif tag == "tbody":
            self._in_table_body = True
        elif tag == "tr" and self._in_table_body:
            self.tariff_row_count += 1
        if tag == "p" and "revision-refund" in classes:
            self.refund_paragraph_count += 1
        if tag == "section" and "data-document-revision-teaser" in values:
            self.teaser_count += 1
            self.section_order.append("document-revision-teaser")
        elif tag == "section" and values.get("aria-labelledby") == "raluma-title":
            self.section_order.append("raluma")
        elif tag == "section" and values.get("aria-labelledby") == "technology-reference-title":
            self.section_order.append("technology-reference")
        if tag == "a":
            self.links.append(values)

    def handle_endtag(self, tag: str) -> None:
        if tag == "tbody":
            self._in_table_body = False

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
    required_flow = ["raluma", "technology-reference", "document-revision-teaser"]
    if aluminum.section_order != required_flow:
        errors.append(
            "aluminum page must place RALUMA and technology references before the document-revision teaser"
        )
    teaser_links = [
        link for link in aluminum.links
        if link.get("href", "").rstrip("/") == "document-revision-check"
    ]
    if len(teaser_links) != 1:
        errors.append(f"teaser must contain one presentation link, found {len(teaser_links)}")
    elif not has_new_tab_contract(teaser_links[0]):
        errors.append("presentation link must open in a new tab with noopener noreferrer")

    if aluminum.text.count("пробное сравнение — 10 000 ₽") != 1:
        errors.append("aluminum teaser must mention 'Пробное сравнение — 10 000 ₽' exactly once")
    forbidden_public_copy = {
        r"саня\s*(?:и|\+)\s*антон": "personal team naming",
        r"15\s*000\s*₽": "legacy price",
        r"быстр\w*.{0,30}безошибочн\w*": "fast and error-free promise",
        r"\bвсе\s+различия\b": "complete-detection promise",
        r"\bбез\s+автоматизаци\w*": "internal automation wording",
    }
    combined_text = f"{aluminum.text} {presentation.text}"
    for pattern, label in forbidden_public_copy.items():
        if re.search(pattern, combined_text):
            errors.append(f"public document-revision offer contains {label}")

    required_ids = {"top", "importance", "process", "deliverable", "input", "boundaries", "terms", "contact"}
    missing_ids = sorted(required_ids - presentation.ids)
    if missing_ids:
        errors.append(f"presentation misses slide anchors: {', '.join(missing_ids)}")
    if presentation.slide_count != 8:
        errors.append(f"presentation must contain the eight-part structure, found {presentation.slide_count} slides")

    required_copy = {
        "сравнение версий архитектурных решений": "official offer title",
        "пто, руководителям строительства и специалистам проекта": "target audience",
        "сверяем состав комплектов": "package-composition step",
        "сопоставляем соответствующие листы": "sheet-matching step",
        "исходная версия раздела ар": "original architectural-solutions input",
        "изменённая версия раздела ар": "changed architectural-solutions input",
        "до / после": "before/after evidence",
        "реестр изменений": "change register",
        "зоны внимания": "attention zones",
        "сопоставимая пара — один лист исходной редакции и один уверенно соответствующий ему лист новой редакции": "comparable-pair definition",
        "81–99 пар": "intake quote for 81–99 pairs",
        "сложные сканы": "difficult-scan intake boundary",
        "несовпадающая структура комплектов": "mismatched-package intake boundary",
        "дополнительная проверка по нормативам": "standards-review intake boundary",
        "для 100–200 пар точную ставку внутри диапазона подтверждаем после приёмки материалов": "variable large-volume rate",
        "только при подтверждённой фактической ошибке": "exact refund boundary",
        "субъективное несогласие само по себе не является основанием для возврата": "subjective-disagreement refund boundary",
        "инженерное решение и приёмка остаются за пто, проектировщиком или другим уполномоченным специалистом": "human engineering acceptance",
        "передать материалы на первичный просмотр": "intake CTA",
    }
    for phrase, label in required_copy.items():
        if phrase not in presentation.text:
            errors.append(f"presentation misses {label}: {phrase}")

    required_prices = ("10 000 ₽", "35 000 ₽", "60 000 ₽", "500–700 ₽ за пару")
    for price in required_prices:
        count = presentation.text.count(price.casefold())
        if count != 1:
            errors.append(f"presentation must show tariff '{price}' exactly once, found {count}")
    if presentation.tariff_table_count != 1:
        errors.append(f"presentation must contain one tariff table, found {presentation.tariff_table_count}")
    if presentation.tariff_row_count != 4:
        errors.append(f"tariff table must contain four body rows, found {presentation.tariff_row_count}")
    if presentation.refund_paragraph_count != 1:
        errors.append(
            f"presentation must contain one concise refund paragraph, found {presentation.refund_paragraph_count}"
        )

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
