# Plan: ОКНОТИКА — выравнивание команды и визуальная ревизия сайта

## Goal

Обновить review-preview ОКНОТИКИ по финальному пакету замечаний Сани: ровная команда 3×3 с четырьмя новыми реальными портретами; более фотографичная алюминиевая страница с RALUMA; отдельная презентация услуги сравнения строительной документации; официальный блок Яндекс.Карт/отзывов; аккуратное публичное упоминание монтажной команды «Рубикон». Результат остаётся review-only и не разворачивается в production.

## Non-goals

- Не менять `admin-app/**`, `deploy/**`, `release/**`, `articles/**`, авторизацию, миграции, инфраструктуру или production-конфигурацию.
- Не выполнять production deploy, merge в `main` или выпуск технического релизного ZIP.
- Не публиковать фото, рендеры, логотип или чертежи Schüco без подтверждённых прав; использовать только лицензированный атмосферный фасадный визуал без утверждения, что на нём продукция Schüco.
- Не использовать вторую фотографию RALUMA, которую Саня явно исключил.
- Не обещать автоматическое инженерное решение, безошибочность, сертификацию, расчёт убытков или возврат денег из-за субъективного несогласия с результатом.
- Не разносить «Рубикон» по всему сайту и не приписывать ОКНОТИКЕ все объекты монтажной команды.

## Context

- Reviewed base: `feature/site-preview-full-20260802` at `ff9835e`.
- Current branch: `feature/site-content-revision-20260802`.
- Task-owned media is supplied outside Git through environment variable `OKNOTIKA_TASK_MEDIA_DIR`:
  - `andrey-svirida.jpg`;
  - `ekaterina-rychkova.png`;
  - `alexey-makarov.png`;
  - `oksana-skopina.png`;
  - `raluma-portal-interior.jpg` (use: first approved photo);
  - `raluma-portal-exterior.jpg` (use: third approved photo);
  - `raluma-portal-loop.mp4` (use as lightweight muted autoplay loop, not a heavyweight GIF);
  - `raluma-unused-second.jpg` (do not publish).
- Yandex organization URL supplied by Sanya contains organization ID `122138017646`; both official iframe endpoints were independently verified HTTP 200:
  - reviews: `https://yandex.ru/maps-reviews-widget/122138017646?comments`;
  - map: `https://yandex.ru/map-widget/v1/?ll=37.647163%2C55.761092&mode=search&oid=122138017646&ol=biz&z=17`.
- Current paid document-comparison offer: 15,000 RUB for comparison of the original and changed architectural-solutions versions; refund only for a confirmed error in the delivered comparison result; the engineering decision and acceptance remain with a human PTO/project/authorized engineer.
- Sanya approved the safe Schüco alternative: a licensed architectural facade photograph used as mood imagery only, never identified as a Schüco object or product.

## Validation Commands

```bash
python3 -m unittest discover -s tests -v
python3 scripts/check_local_refs.py .
python3 scripts/check_team_dom.py .
python3 scripts/check_aluminum_composition.py .
python3 scripts/check_aluminum_sources.py .
python3 scripts/check_public_claims.py .
python3 - <<'PY'
from pathlib import Path
from html.parser import HTMLParser
for path in [Path('index.html'), Path('aluminum/index.html'), Path('aluminum/document-revision-check/index.html')]:
    HTMLParser().feed(path.read_text(encoding='utf-8'))
print('html-parse-ok')
PY
```

Render and inspect at minimum:

- homepage at 1440 px and 390 px;
- aluminum page at 1440 px and 390 px;
- document-revision presentation at 1440 px and 390 px;
- verify no horizontal overflow, team order/crops, iframe responsiveness, new-tab CTA, muted looping portal video, and readable text over photography.

## Tasks

### Task 1: Normalize the 3×3 team block and replace four portraits

**Goal:** Make all nine people visually consistent and place them in Sanya's exact order.

**Serves:** Sanya reported that team photos had “разлетелись”, supplied replacements for Makarov, Svirida, Skopina and Rychkova, and explicitly requested three rows of three.

- [x] Produce web-sized derivatives from the four supplied real photos without synthesizing or changing faces; use consistent 4:5 crop and compression.
- [x] Replace the Svirida placeholder and the existing Makarov, Skopina and Rychkova images.
- [x] Set exact DOM order: Zolotukhin / Makarov / Blagochevsky; Vodyanov / Ryabokon / Svirida; Skopina / Irina Blagochevskaya / Rychkova.
- [x] Make desktop/tablet three columns and mobile one column, with consistent image boxes and no portrait stretching.
- [x] Update provenance/approval records and focused team assertions.
- [x] Validate Task 1 outcome.

### Task 2: Recompose aluminum and RALUMA blocks around approved photography

**Goal:** Remove schematic/caption clutter and make the aluminum page materially more visual while preserving safe sourced claims.

**Serves:** Sanya asked to move RALUMA lower, use the first and third RALUMA photos plus the portal video, replace strange schemes and captions with large photography, and place the “from facade grid to checked node” copy in roughly the left two-fifths on desktop.

- [x] Replace abstract Schüco visuals on the homepage aluminum card and aluminum page with the existing licensed architectural facade mood photograph; alt/copy must not claim it is a Schüco object/product.
- [x] Remove captions such as “авторская схема ОКНОТИКИ”, “чертёж узла” and “изображение продукции Schüco”; do not introduce replacement legalistic caption clutter.
- [x] Rebuild the design-path hero as a large photographic composition with desktop copy occupying approximately 40% and a readable mobile fallback; retain the useful six-step content without duplicating it into noisy cards.
- [x] Move the detailed RALUMA feature after the main Schüco/design content and build it from the first approved photo, muted autoplay/loop/playsinline MP4, and third approved photo. Supply a poster/fallback and preserve performance.
- [x] Remove the “Объектная проверка / Система-кандидат / не обещание поставки / доступность профилей” block and all matching jargon from visible copy.
- [x] Update provenance and aluminum composition/source checks for removed in-house schemes and newly supplied RALUMA media.
- [x] Validate Task 2 outcome.

### Task 3: Add a standalone document-revision presentation and safe teaser

**Goal:** Replace the removed aluminum caveat with a compact sales teaser that opens a self-contained presentation in a new tab.

**Serves:** Sanya explicitly asked to insert the joint Sanya/Anton construction-document comparison offer into that site location and open it “в отдельном окне презентацией”.

- [ ] Create `aluminum/document-revision-check/index.html` as a concise static slide-like presentation consistent with the site design.
- [ ] Explain input, evidence-backed before/after/change register, deliverable, current price 15,000 ₽, exact refund boundary, and mandatory human engineering acceptance.
- [ ] Add a direct Telegram CTA without claiming automatic approval, perfect detection, legal conclusion or engineer replacement.
- [ ] Add a compact teaser on the aluminum page linking with `target="_blank"` and `rel="noopener noreferrer"`.
- [ ] Validate Task 3 outcome, copy boundaries and internal references.

### Task 4: Strengthen homepage visuals, cases and official Yandex proof

**Goal:** Finish the homepage review package with photography, one bounded Rubikon proof block and responsive official Yandex embeds.

**Serves:** Sanya asked for more photography in the Schüco and Art/Thermo/Smart/glass areas, a named Rubikon/Lunkash installation-partner mention in cases, and a live Yandex reviews/map widget from the supplied organization card.

- [ ] Replace the homepage glass SVG card with an existing licensed glass photograph and keep the product link intact.
- [ ] In the cases area, state that ОКНОТИКА remains the single responsibility center and that the team of company «Рубикон», led by Сергей Константинович Лункаш, is a permanent installation partner for commercial, social and private objects. Keep this bounded to cases and do not transfer authorship of all Rubikon work to ОКНОТИКА.
- [ ] Add official lazy-loaded Yandex reviews and map iframes using organization ID `122138017646`, plus a direct “Оставить отзыв”/open-in-Yandex link; make the block responsive without hardcoded rating or review count.
- [ ] Extend focused DOM/public-claim/reference checks only as needed for the changed static preview.
- [ ] Run the full validation commands and rendered desktop/mobile QA for all three affected pages.
- [ ] Review the final diff for scope, copy accuracy, private-data leakage and unintended admin/deploy/release changes.
- [ ] Validate Task 4 outcome.
