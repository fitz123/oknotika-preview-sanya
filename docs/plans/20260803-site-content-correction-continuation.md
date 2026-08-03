# Plan: ОКНОТИКА — коррекция review-preview после просмотра Сани

## Goal

Пересобрать существующий review-preview и PR #4 по финальным замечаниям Сани: перенести и усилить блок «Рубикона» без ложной атрибуции всей подборки, убрать заметные повторы фотографий внутри публичных страниц, переписать презентацию сравнения версий АР на официальный русский коммерческий язык, заменить пробную цену на 10 000 ₽ и добавить подтверждённую тарифную сетку. Результат остаётся review-only.

## Parent lineage

- Parent plan: `docs/plans/completed/20260802-site-content-revision.md`.
- Current branch: `feature/site-content-revision-20260802`.
- Required starting HEAD: `97f62ee8977d3273ed1fbdb0baa4db285282023a`.
- Reviewed base remains `feature/site-preview-full-20260802` at `ff9835e78049f21ae88461fc56daad8abc576454`.
- Existing pull request: `https://github.com/fitz123/oknotika-preview-sanya/pull/4`.
- This is a Sanya-approved requirement continuation of the same logical run/repository/branch/scope, not a second product scope.

## Non-goals

- No merge, production deploy, release ZIP/manifest rebuild or changes under `admin-app/**`, `deploy/**`, `release/**`, `articles/**`.
- No new external media downloads, Schüco-owned media, excluded second RALUMA photo, or changes to the approved RALUMA photo/video trio.
- No changes to team people, order, portraits or approval evidence; no Yandex widget/consent changes.
- No claim that every pictured case belongs to «Рубикон» and no claim that ОКНОТИКА directly executed every partner object.
- No absolute promise of error-free or complete detection; no automatic project approval, legal conclusion, loss calculation or replacement of the responsible engineer.
- Do not erase historical prices from completed plans/artifacts merely to make searches clean. Correct active public pages, active tests/checkers and PR metadata.
- Do not solve repetition by filling pages with generic new abstractions or by reducing product pages to empty text walls. Keep a meaningful photographic hero and unique gallery/video where approved assets exist.

## Copy and commercial boundary

Use Sanya's supplied Russian draft as the semantic basis, edited for factual precision and Oknotika's audience.

Preferred public structure:

1. **Сравнение версий архитектурных решений** — прозрачная фиксация изменений для инженерных решений.
2. **Почему это важно** — ПТО, руководители строительства and project specialists need to see what changed without manually comparing every sheet.
3. **Как работаем** — confirm package composition, compare corresponding sheets, record visible `до / после`, and flag ambiguous areas requiring engineering judgment.
4. **Что получает заказчик** — a register of identified differences, source-fragment/sheet references, and a zone of attention.
5. **Что нужно для старта** — fixed Version A and Version B, file/version labels, short comparison objective and responsible contact.
6. **Границы** — the result is a working evidence register; engineering decision and acceptance remain with PTO/designer/authorized specialist; ambiguous mappings are escalated for clarification.
7. **Прозрачные условия** — refund only for a confirmed factual error in the delivered comparison result; subjective disagreement is not itself a refund basis.
8. **CTA** — `Передать материалы на первичный просмотр`.

Avoid these phrases or equivalents:

- `быстро и безошибочно`;
- `все различия`;
- `без автоматизации`;
- `Саня и Антон` / `Саня + Антон`;
- repeated defensive disclaimers or repeated price banners.

Confirmed pricing:

| Формат | Объём | Стоимость |
|---|---|---:|
| Пробное сравнение | До 5 сопоставимых пар листов | 10 000 ₽ |
| Основной | До 30 сопоставимых пар листов | 35 000 ₽ |
| Расширенный | До 80 сопоставимых пар листов | 60 000 ₽ |
| Большой объём | 100–200 сопоставимых пар листов | 500–700 ₽ за пару |

A comparable pair means one sheet from the source revision and its confidently matching sheet from the new revision. Volumes 81–99 pairs, difficult scans, mismatched package structures and additional standards review are quoted after intake. For 100–200 pairs, the exact rate inside the range is confirmed after intake.

## Validation commands

```bash
git diff --check
python3 scripts/check_local_refs.py .
python3 scripts/check_team_dom.py .
python3 scripts/check_aluminum_sources.py .
python3 scripts/check_public_claims.py .
python3 scripts/check_document_revision.py .
python3 scripts/check_homepage_proof.py .
python3 scripts/check_public_media_repetition.py .
python3 scripts/check_aluminum_composition.py .
python3 scripts/check_site_content_render.py .
python3 -m unittest tests/test_release_guardrails.py -v
node --check script.js
```

Rendered QA at 1440 px and 390 px must cover homepage, aluminum, document-comparison presentation, glass, PVC, Carbon Glass, smart window, Protectapeel and Stoller. Verify no horizontal overflow, correct case/partner order, readable tariff table and no visible repeated photo within any one page. Logo reuse, responsive `<picture>` alternatives and a poster used only as the fallback for its own video do not count as photo duplication.

## Tasks

### Task 1: Correct homepage cases and «Рубикон» emphasis

**Goal:** Put the valued partner context before the case photos while keeping the case grid a mixed Oknotika/partner-network portfolio.

**Serves:** Sanya corrected that the grid includes both Oknotika and partner objects, asked to keep the prior general cases text, move «Рубикон» above the photos, and highlight the team as a favourite/trusted partner without defensive attribution language.

- [x] Keep the general headline `Реальные объекты и монтажные объёмы` and clearly describe the grid as a mixed selection from ОКНОТИКА and its partner network.
- [x] Move `[data-rubikon-proof]` before `.case-grid`.
- [x] Describe the team of company «Рубикон», led by Сергей Константинович Лункаш, as a permanent installation partner that ОКНОТИКА especially values and trusts for its experience, reliability and quality of joint work.
- [x] Remove the sentence about independent Rubikon objects not being attributed to Oknotika; do not replace it with another defensive disclaimer.
- [x] Keep individual case captions neutral and do not state that the whole grid is Rubikon work.
- [x] Replace the duplicated homepage hero `botanical-garden.jpg` with the existing `atrium.jpg`; keep Botanical Garden only in its case card.
- [x] Update focused homepage assertions and spacing.
- [x] Validate Task 1 outcome.

### Task 2: Rewrite the AR-comparison offer and pricing

**Goal:** Turn the current internal-sounding, repetitive 15,000 ₽ page into an official, concise Russian commercial presentation with one clear tariff table and one bounded refund rule.

**Serves:** Sanya rejected public `Саня и Антон`, supplied the Russian-market copy direction, changed the trial to 10,000 ₽ and confirmed the earlier sheet-pair tariff grid.

- [x] Replace personal naming in the aluminum teaser and standalone presentation with `команда ОКНОТИКИ` or neutral company voice.
- [x] Rewrite the presentation using the eight-part copy structure and boundaries above; preserve human engineering authority and evidence-backed `до / после` logic.
- [x] Replace every active public 15,000 ₽ occurrence with the confirmed commercial model.
- [x] On the aluminum teaser, mention `Пробное сравнение — 10 000 ₽` once and link to the presentation in a new tab.
- [x] In the presentation, show the four-row pricing table once, explain comparable pairs, the 81–99 intake quote and variable 100–200 rate.
- [x] Keep one concise transparent refund paragraph: confirmed factual result error only; subjective disagreement is not enough.
- [x] Remove repeated price blocks and unsafe absolutes; keep the CTA `Передать материалы на первичный просмотр`.
- [x] Update focused document/public-claim assertions.
- [x] Validate Task 2 outcome.

### Task 3: Remove visible same-page photo duplication across public product pages

**Goal:** Ensure each noticeable photograph appears at most once within a single affected page, using existing approved media and text-backed cards where the current design has more visual slots than unique assets.

**Serves:** Sanya noticed the repeated facade and then asked to avoid duplicates across the site wherever practical.

- [x] On `aluminum/index.html`, keep each facade photo in one role only: use a unique licensed facade photo for the Schüco focus, a different existing photo for the design path, and convert duplicated taxonomy-card imagery to text-backed styling where necessary. Preserve safe Schüco provenance and all approved RALUMA media.
- [x] On `glass/index.html`, `pvc/index.html`, `carbon-glass/index.html`, `protectapeel/index.html` and `wood-stoller/index.html`, make scenario cards text-backed where needed and reserve each approved photograph for one hero/gallery role only.
- [x] On `oknotika-smart-window/index.html`, replace the repeated tight demo image with another existing unique Oknotika product photo or approved diagram already in the repository.
- [x] Keep real photographic heroes where possible; use an existing product SVG only when it is an approved product diagram and no truthful unique photo remains for that role.
- [x] Treat the Protectapeel video poster as part of that video, not a separate duplicate; do not show the same poster frame again as a standalone tile.
- [x] Add a deterministic checker that rejects visible same-page local-media repetition on the affected pages while excluding logo, `<picture>` alternatives and video-only poster fallback.
- [x] Update image/aluminum provenance only for changed published uses.
- [x] Validate all eight affected pages at desktop and mobile widths.

### Task 4: Refresh guardrails, review evidence and existing PR

**Goal:** Prevent regression and deliver a new immutable review-preview on the same branch/PR without touching production scope.

**Serves:** Sanya asked to rebuild the existing preview after completing the correction batch, not to deploy it.

- [ ] Update only focused scripts/tests that currently enforce rejected price, identity, partner order or duplicated media.
- [ ] Run all validation commands and rendered QA for the nine affected pages at 1440 px and 390 px.
- [ ] Confirm no active public `15 000`, `Саня и Антон`, `Саня + Антон`, unsafe absolute promise, or old defensive Rubikon sentence remains.
- [ ] Confirm no changed path under `admin-app/**`, `deploy/**`, `release/**` or `articles/**`.
- [ ] Review the final diff as a cut pass for unnecessary mechanisms and visual regressions.
- [ ] Refresh only affected QA evidence and prepare the existing PR #4 for parent-owned push/review; do not merge or deploy.
- [ ] Validate Task 4 outcome.
