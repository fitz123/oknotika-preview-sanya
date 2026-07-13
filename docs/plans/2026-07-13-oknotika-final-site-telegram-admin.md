# Итоговая версия сайта ОКНОТИКИ: команда, Schüco и Telegram-админка

## Goal

Собрать финальный релиз сайта на утверждённой базе V2.27 без общего редизайна:

- сохранить компоновку, увеличенную десктопную «чёлку» и продуктовую структуру V2.27;
- заменить шесть мужских портретов новой съёмкой, сохранив восемь публичных карточек команды;
- исправить роль Евгения Жалнина на **«Операционный директор»**;
- углубить алюминиевую страницу по официальным материалам и выделить Schüco отдельным фасадным блоком;
- добавить закрытую Telegram-авторизацию и мини-редактор, чтобы Саня сам публиковал «Факт недели»;
- сохранить публичный сайт статическим и быстрым: админ-сервис генерирует готовые HTML-страницы и атомарно публикует их;
- подготовить секрет-безопасный пакет развёртывания и отката для Жени.

Non-goals:

- переход на WordPress, Tilda или тяжёлую CMS;
- публичный CMS/API;
- переделка уже одобренных продуктовых страниц;
- заявление об официальном партнёрстве/дилерстве Schüco;
- использование фотографий, логотипа или чертежей Schüco без подтверждённых прав.

## Context

- Репозиторий: `artifacts/tasks/2026-07-07-oknotika-site-zip/site/`.
- Зафиксированная база: commit `5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed` (V2.27).
- Approved selected raw inputs are available read-only under `.tmp-inputs/team-shoot/` and are excluded from Git.
- Do not commit raw shoot files or EXIF-bearing originals; commit only optimized approved public portraits.
- Существующая публичная рубрика: `/articles/`, название **«Факт недели»**.
- Текущий серверный контур: статический сайт за nginx; пакет для Жени должен поддержать Linux/nginx/systemd.
- `artifacts/governance/decisions.md` отсутствует; ADR пока не создан.

## Decisions

1. **Базу V2.27 не перестраивать.** Изменения ограничены командой, алюминием, публикацией статей и служебной документацией.
2. **Команда остаётся из восьми карточек.** Новые фото получают Роман Водянов, Дмитрий Благочевский, Иван Рябоконь, Дмитрий Цветков, Евгений Жалнин и Александр Золотухин. Сергей Бешенцев и Оксана Скопина остаются без замены.
3. **Евгений Жалнин — Операционный директор.** Формулировка `Генеральный директор` удаляется из сайта, манифестов, карточек и новых пакетов.
4. **Schüco остаётся отдельной философией.** АЛЮТЕХ + Алюмарк остаются практическим объектовым вариантом; Schüco получает самостоятельный фасадный раздел.
5. **Разрешённые семейства для публичного объяснения:** FWS 50, FWS 35 PD, FWS 60 CV, AF UDC 80/80 CV; AWS 75 PD.SI используется только как точный пример окна, совместимого с FWS 35 PD.
6. **Скрытый дренаж не обобщать.** Упоминать только в подтверждённом контексте AWS 75 PD.SI.
7. **Публичная рубрика остаётся `/articles/` и «Факт недели».** Новый пункт меню не добавляется; публичной ссылки на админку нет.
8. **Архитектура публикации:** отдельный малый Node.js-сервис + SQLite + Telegram OIDC. Один immutable article-release содержит index, `latest.json`, detail HTML и hashed assets; публичной истиной является один active symlink. Падение админки не роняет публичный сайт.
9. **Авторизация:** отдельное корпоративное приложение Telegram Web Login/OIDC, один configured editor на старте, allowlist по проверенному `(issuer, subject)`, без авторизации по username/телефону.
10. **OIDC contract:** использовать официальную discovery-конфигурацию Telegram, Authorization Code Flow, PKCE `S256`, exact redirect URI и один разрешённый алгоритм подписи из discovery. `state`, `nonce` и PKCE verifier — серверные, одноразовые и с TTL. Валидировать signature, `iss`, `sub`, `aud`, `exp`, `iat`, `nonce`; `azp` — только если claim присутствует и применим. При неизвестном `kid` выполнить один bounded JWKS refresh и затем fail closed.
11. **Админ-домен по умолчанию:** `admin.oknotika.ru`; canonical public/admin origins задаются обязательной production-конфигурацией.
12. **Редактор MVP:** черновик, закрытый preview, публикация, снятие и два разных отката: возврат редакционной ревизии и operational rollback целого release.
13. **Editorial semantics:** рубрика фиксирована как `Факт недели`; обязательны title, publication date, lead, Markdown body, cover и alt; source URL опционален, но если указан — только `https:` и никогда не загружается сервером. Время хранится UTC, показывается `Europe/Moscow`.
14. **Slug semantics:** slug создаётся один раз из первого title транслитерацией в lowercase ASCII; collision получает `-2`, `-3`; после первого сохранения slug неизменяем. Смена title не меняет URL.
15. **Withdrawal semantics:** снятая статья удаляется из listing и `latest`; её detail URL возвращает статическую 410-страницу. `latest` переключается на предыдущую опубликованную статью.
16. **Старый материал Al Bahr импортируется как первая опубликованная ревизия с тем же URL, видимым текстом, метаданными и стилем; это защищает golden-render test.**
17. **Crash-consistency:** один publisher lock; staging и active releases находятся на одной файловой системе; после полной валидации выполняется atomic rename/symlink switch. Active symlink — источник истины; SQLite записывает завершённый publish после switch, а startup reconciliation исправляет незавершённое состояние по release manifest.
18. **Cache contract:** HTML, listing и `latest.json` — `no-cache`/revalidate; только hashed media assets — immutable. Главная остаётся статической и читает `/articles/latest.json`, поэтому публикация не переписывает homepage HTML.
19. **Private boundary:** SQLite, sessions, secrets, uploads, drafts, previews и unpublished derivatives находятся вне Git, ZIP и nginx document root. Preview требует auth, имеет unguessable ID, `no-store` и `noindex`.
20. **Секреты и runtime-данные не попадают в Git/Telegram.** В репозитории только placeholders, миграции, код, оптимизированные публичные изображения и инструкции.

## Assumptions

- Саня подтвердил назначение новой съёмки для сайта, одобрил approval sheet реакцией и отдельно исправил роль Жалнина; утверждённые на sheet кадры не меняются без нового согласования.
- На старте один редактор — Саня; публикация примерно раз в неделю. Расширение редакторов и RBAC отложены.
- Перед production в release-evidence фиксируются источник каждого raw-кадра, crop, final hash, одобрение Сани и подтверждение права ОКНОТИКИ использовать съёмку на сайте; приватные соглашения в ZIP не входят.
- Жене доступны DNS, TLS, nginx, systemd и постоянный локальный диск VPS.
- Telegram OIDC credentials и allowlisted subject будут добавлены Женей через секретный канал после создания Web Login приложения.
- Для Schüco официальные страницы используются только как фактические источники; текст пересказывается, а логотипы, фото, рендеры, скриншоты и чертежи не копируются без отдельного права.

## Risk Register

| Risk | Severity | Mitigation | Rollback |
|---|---|---|---|
| Потеря одобренного вида V2.27 | HIGH | Зафиксировать baseline-скриншоты и diff allowlist | Вернуть commit/ZIP V2.27 |
| Ошибка в фото/роли | HIGH | Полный восьмикарточный approval sheet перед публикацией | Вернуть прежний asset и HTML |
| Неподтверждённый claim Schüco | HIGH | Claim-level карта официальных источников | Удалить спорный блок без затрагивания страницы |
| Нарушение прав на изображение | HIGH | Только свои/лицензированные изображения с provenance | Заменить asset и очистить cache |
| Компрометация админки | HIGH | OIDC, allowlist, server sessions, CSRF, sanitizer, rate limit | Отключить admin vhost/service; публичный сайт продолжит работать |
| Повреждение статьи при публикации | HIGH | Immutable releases + temp render + validation + atomic switch | Переключить symlink на предыдущий article release |
| Потеря SQLite/uploads | HIGH | Online backup после публикации + nightly encrypted off-host | Restore DB + originals + regenerate static release |
| Неподходящий production topology | MED | Секрет-безопасный пакет с placeholders и preflight | Не включать admin routing до подтверждения Жени |

## Validation Commands

```bash
repo='.'

# База, allowlist и чистота diff
git -C "$repo" rev-parse 5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed^{tree}
git -C "$repo" diff --check
python3 "$repo/scripts/check_v227_allowlist.py" \
  --repo "$repo" --baseline 5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed

# Статика и структурные assertions
python3 "$repo/scripts/check_local_refs.py" "$repo"
python3 "$repo/scripts/check_team_dom.py" "$repo/index.html" "$repo/release-evidence/team-release-evidence.json"
python3 "$repo/scripts/check_public_claims.py" "$repo"
node --check "$repo/script.js"
node --check "$repo/js/latest-fact.js"

# Backend
cd "$repo/admin-app"
npm ci
npm run lint
npm test
npm run test:security
npm run build
npm run render:fixture

# Release integrity
cd ..
python3 scripts/check_generated_articles.py var/test-release
python3 scripts/check_aluminum_sources.py ALUMINUM_SOURCES.md aluminum/index.html
python3 scripts/scan_release_zip.py release/oknotika-final.zip

# Deploy package (в Linux-контуре Жени; URL задаются явно)
nginx -t
systemd-analyze verify deploy/systemd/oknotika-admin.service
./deploy/scripts/smoke-test.sh \
  --base-url "$OKNOTIKA_PUBLIC_ORIGIN" \
  --admin-url "$OKNOTIKA_ADMIN_ORIGIN"
```

## Tasks

### Task 1: Зафиксировать V2.27 и визуальные границы [HIGH]

**Goal:** гарантировать, что итоговый релиз не разрушит уже одобренный сайт.

**Files:**
- Create: `release-evidence/baseline/`
- Create: `scripts/check_local_refs.py`

- [x] подтвердить exact tree commit `5364ff1` и сохранить manifest tracked-файлов и их hashes;
- [x] снять baseline-скриншоты pinned Chromium-версией на 1440, 1280, 1180, 768, 760 и 390 px;
- [x] определить exact path/DOM allowlist и page-scoped CSS selectors; запретить unrelated cleanup;
- [x] реализовать `scripts/check_v227_allowlist.py`, сравнивающий final tree непосредственно с `5364ff1`;
- [x] добавить проверку локальных ссылок без изменения существующих страниц;
- [x] запустить baseline checks и сохранить результаты и допустимый visual-diff threshold.

### Task 2: Подготовить финальные восемь карточек команды [HIGH]

**Goal:** заменить шесть фотографий новой съёмкой и исправить роль Жалнина.

**Files:**
- Modify: `index.html`
- Create: `tools/team-portraits/create_final_portraits.py`
- Create: `release-evidence/team-release-evidence.json`
- Create: `img/team/*-2026-07.webp`
- Create: `release-evidence/team-approval/`

- [x] исправить роль Жалнина на `Операционный директор` во всех генераторах и метаданных;
- [x] сохранить утверждённые Саней raw-кадры из approval sheet, не подменяя кадр Жалнина без нового запроса;
- [x] нормализовать 4:5 crop, eye line и масштаб лица напрямую из утверждённых raw без изменения идентичности/выражения;
- [x] экспортировать шесть versioned WebP/JPEG без EXIF суммарным весом не более 900 KB;
- [x] обновить шесть `src`, `alt`, `width`, `height`, `loading="lazy"`, `decoding="async"`;
- [x] сохранить Сергея Бешенцева и Оксану Скопину без изменений;
- [x] создать desktop/mobile approval sheet всех восьми карточек;
- [x] записать `team-release-evidence.json`: raw path/hash, crop, final hash, роль, timestamp одобрения и approver;
- [x] зафиксировать внутреннее подтверждение web-use rights на съёмку без включения приватных документов в ZIP;
- [x] проверить структурным DOM/manifest-тестом восемь уникальных карточек, шесть новых hashes, два неизменённых hashes и точную роль Жалнина;
- [x] запустить responsive screenshots и image-reference tests.

### Task 3: Углубить алюминий и выделить фасады Schüco [HIGH]

**Goal:** сохранить понравившуюся алюминиевую страницу, но сделать Schüco отдельным и более сильным фасадным контуром.

**Files:**
- Modify: `aluminum/index.html`
- Modify: `index.html`
- Modify: `style.css`
- Modify: `IMAGE_SOURCES.md`
- Create: `ALUMINUM_SOURCES.md`
- Create: `img/aluminum/schueco-*.webp`
- Create: `scripts/check_aluminum_sources.py`

- [ ] сохранить существующую taxonomy брендов без перестановки продуктовой логики;
- [ ] добавить самостоятельный hero/focus `Schüco — отдельная системная философия фасада`;
- [ ] добавить четыре сценария FWS 50, FWS 35 PD, FWS 60 CV и AF UDC 80/80 CV;
- [ ] добавить блок интегрированной оболочки: окна, двери, раздвижные элементы, солнцезащита, вентиляция и автоматика только в совместимых конфигурациях;
- [ ] добавить блок пути проектирования от фасадной сетки к проверяемому узлу;
- [ ] ограничить claim о скрытом дренаже контекстом AWS 75 PD.SI;
- [ ] добавить availability/compliance caveat под объект;
- [ ] использовать только оригинальную схему и лицензионно безопасные фасадные визуалы; не копировать Schüco logo/photo/render/screenshot/drawing только потому, что они есть на официальном сайте;
- [ ] пересказать официальные claims своими словами и записать источник, URL, дату получения, лицензию и поддерживаемый claim каждого опубликованного материала;
- [ ] добавить проверку запрещённых обобщений и отсутствующих provenance-записей;
- [ ] проверить desktop/mobile page composition и главную карточку алюминия.

### Task 4: Добавить генератор статических статей [HIGH]

**Goal:** отделить редактирование от публичной выдачи и сохранить статический индексируемый сайт.

**Files:**
- Create: `admin-app/src/content/`
- Create: `admin-app/src/render/`
- Create: `admin-app/migrations/`
- Create: `admin-app/templates/public/`
- Modify: `articles/index.html`
- Modify: `articles/al-bahr-towers-dynamic-facade/index.html`
- Create: `js/latest-fact.js`

- [ ] определить SQLite schema для одного configured editor, articles, immutable revisions, assets, releases и audit events;
- [ ] реализовать зафиксированные required/optional fields, UTC storage и `Europe/Moscow` display;
- [ ] реализовать immutable slug, collision suffix и неизменяемость URL при смене title;
- [ ] реализовать ограниченный Markdown без raw HTML и серверную sanitation;
- [ ] хранить source URL без server-side fetch, допуская только валидный `https:`;
- [ ] импортировать Al Bahr как первую опубликованную ревизию и защитить URL/content/metadata/style golden-render test;
- [ ] генерировать единый immutable release: `/articles/index.html`, `/articles/latest.json`, detail HTML, 410 pages и hashed cover derivatives;
- [ ] генерировать canonical и Open Graph metadata;
- [ ] встроить latest fact на главную с сохранением статического fallback;
- [ ] держать drafts/previews/unpublished assets вне public root; preview — authenticated, unguessable, `no-store`, `noindex`;
- [ ] реализовать single-publisher lock, same-filesystem staging и полный manifest validation;
- [ ] реализовать atomic active-symlink switch, publish-complete DB ordering и startup reconciliation от active manifest;
- [ ] реализовать `no-cache`/revalidation для HTML/JSON и immutable cache только для hashed assets;
- [ ] разделить editorial revision restore и operational whole-release rollback;
- [ ] написать failure-injection tests до/после каждого publish boundary, draft visibility, slug, withdrawal/410, latest fallback и rollback;
- [ ] запустить tests и fixture-render.

### Task 5: Добавить Telegram OIDC и закрытую админку [HIGH]

**Goal:** дать allowlisted редактору безопасно создавать, просматривать и публиковать факт недели.

**Files:**
- Create: `admin-app/package.json`
- Create: `admin-app/package-lock.json`
- Create: `admin-app/src/auth/`
- Create: `admin-app/src/http/`
- Create: `admin-app/templates/admin/`
- Create: `admin-app/tests/`
- Create: `admin-app/.env.example`
- Modify: `.gitignore`

- [ ] на первом шаге проверить official Telegram discovery metadata, issuer, endpoints, `S256`, token auth method и signing algorithms и сохранить conformance fixture;
- [ ] реализовать server-side Authorization Code Flow с exact redirect URI и server-bound одноразовыми `state`, `nonce`, PKCE verifier с TTL;
- [ ] валидировать JWKS signature, pinned allowed algorithm, `iss`, `sub`, `aud`, `exp`, `iat`, `nonce` и `azp` только если применим;
- [ ] при unknown `kid` выполнить один bounded JWKS refresh и fail closed;
- [ ] разрешать вход только одному configured allowlisted `(issuer, subject)` и отложить editor CRUD/RBAC;
- [ ] добавить out-of-band enrollment procedure для первого verified subject;
- [ ] создать opaque server sessions с `__Host-` Secure HttpOnly SameSite=Lax cookie;
- [ ] добавить idle/absolute timeout, logout и revocation при отключении редактора;
- [ ] добавить CSRF token, exact Origin и Fetch Metadata checks;
- [ ] реализовать черновик, preview, publish, withdraw и rollback с явным подтверждением;
- [ ] добавить optimistic revision checks и audit events;
- [ ] валидировать actual signature/MIME JPEG/PNG/WebP до 10 MB и 40 MP, применять decoder CPU/memory/time limits, re-encode, strip EXIF, random private filenames и запретить SVG/GIF;
- [ ] держать originals и unpublished derivatives вне public root и копировать в release только validated published derivatives;
- [ ] запретить raw HTML и unsafe/non-HTTPS source URL; никогда не загружать source URL сервером;
- [ ] написать auth/security/upload/XSS/CSRF/replay/non-allowlist tests;
- [ ] запустить lint, tests и security tests.

### Task 6: Подготовить nginx/systemd/backup пакет для Жени [HIGH]

**Goal:** обеспечить воспроизводимое размещение без передачи секретов в репозитории или Telegram.

**Files:**
- Create: `deploy/nginx/`
- Create: `deploy/systemd/`
- Create: `deploy/scripts/`
- Create: `deploy/README_ZHENYA.md`

- [ ] зафиксировать runtime layout: `/opt/oknotika-admin/releases/<sha>`, `/var/lib/oknotika-admin/{db,uploads,previews,article-releases}`, `/run/oknotika-admin/app.sock`, service user `oknotika-admin`;
- [ ] pin Node 24 LTS major и exact patch в release manifest; pin SQLite/library versions lockfile-ом;
- [ ] подготовить public nginx mapping для одного active immutable `/articles/` release;
- [ ] подготовить `admin.oknotika.ru` reverse proxy только к Unix socket с владельцем/группой `oknotika-admin:www-data` и режимом `0660`;
- [ ] доверять forwarded headers только от локального nginx и валидировать configured canonical origins;
- [ ] добавить no-store, CSP, HSTS, nosniff, frame-ancestors, rate limits и upload limit;
- [ ] подготовить hardened systemd unit под отдельным непривилегированным пользователем;
- [ ] добавить sample config только с placeholders; production secrets подавать через systemd credentials/секрет-хранилище и описать rotation;
- [ ] выбрать restic для encrypted off-host backup; ключ хранить в секрет-хранилище, retention 7 daily / 8 weekly / 12 monthly;
- [ ] backup-set включает SQLite online snapshot, private originals, release manifests/required derivatives и audit state; RPO 24 часа плюс backup после publish, RTO 2 часа;
- [ ] применять backward-compatible migrations; перед каждой migration делать verified backup и тестировать application downgrade с DB restore при breaking change;
- [ ] добавить restore drill, first-editor enrollment/removal и emergency-disable runbook;
- [ ] добавить раздельные content, marketing и application rollback procedures;
- [ ] добавить локальные template/static checks; `nginx -t`, systemd и live smoke tests оставить обязательным production gate в runbook.

### Task 7: Провести beta rehearsal и собрать итоговый релиз [HIGH]

**Goal:** доказать работоспособность до production-передачи.

**Files:**
- Create: `release-evidence/previews/`
- Create: `release-evidence/qa/`
- Create: `release/`

- [ ] проверить статические страницы и сравнить с V2.27 baseline;
- [ ] проверить команду на 1440/1280/1180/768/760/390 px;
- [ ] проверить алюминий и Schüco на desktop/mobile;
- [ ] проверить mocked valid/forged/stale/replayed/wrong-issuer/wrong-audience/wrong-alg/unknown-kid/non-allowlisted OIDC cases;
- [ ] добавить отдельный production rehearsal runbook для реального Telegram OIDC login/logout/revocation после передачи credentials;
- [ ] проверить draft invisibility, preview, publish, edit, withdraw и rollback;
- [ ] проверить XSS, CSRF, unsafe URL, malformed/oversized/decompression-bomb images;
- [ ] проверить canonical/OG и Telegram link preview;
- [ ] проверить crash injection вокруг staging/rename/symlink/DB finalize и startup reconciliation;
- [ ] проверить restic backup, integrity и реальный restore drill в изолированный каталог;
- [ ] проверить application downgrade на восстановленной pre-migration DB;
- [ ] провести отключение admin service и подтвердить доступность публичного сайта;
- [ ] собрать versioned secret-free ZIP, checksums и release notes.

### Task 8: Verify acceptance criteria [HIGH]

**Goal:** подтвердить выполнение всех целей без скрытой деградации V2.27.

- [ ] exact tree diff относительно `5364ff1` укладывается в path/DOM/CSS allowlist, а V2.27 header/composition сохранены на 1440, 1280 и 390 px;
- [ ] структурный тест подтверждает восемь карточек, шесть новых portrait hashes, два прежних hashes и роль Жалнина только `Операционный директор`;
- [ ] Schüco визуально отделён, фасадный блок подтверждён официальными источниками;
- [ ] в опубликованных материалах нет неподтверждённого партнёрства или нелицензированных Schüco assets;
- [ ] один active release атомарно обновляет `/articles/`, detail pages и `latest.json`; статическая главная получает новую карточку только через согласованный `latest.json`;
- [ ] drafts не видны публично, rollback восстанавливает предыдущий release;
- [ ] mocked Telegram OIDC conformance и auth/security/upload/header/cookie tests проходят; реальный OIDC rehearsal обозначен production gate;
- [ ] full test suite и linter проходят;
- [ ] nginx/systemd smoke checks проходят в Linux-контуре;
- [ ] automated ZIP scan подтверждает отсутствие `.env`, secrets, SQLite/WAL/SHM, uploads, previews, raw photos, logs и runtime releases.

### Task 9: Update documentation [HIGH]

**Goal:** передать поддерживаемую систему без зависимости от памяти участников.

- [ ] обновить `README.md` до финальной версии и убрать устаревшие V2.18/V2.25 markers;
- [ ] обновить `IMAGE_SOURCES.md` и добавить `ALUMINUM_SOURCES.md`;
- [ ] задокументировать content model, Telegram enrollment и editor flow;
- [ ] задокументировать deploy, backup, restore, rollback и emergency disable;
- [ ] записать release SHA/checksums и список изменённых файлов;
- [ ] после отдельного подтверждения пользователя записать архитектурное решение в ADR.

## Required deployment inputs later

Эти данные не блокируют локальную реализацию и beta-package, но обязательны перед production:

- создание отдельного Telegram Web Login приложения/бота ОКНОТИКИ;
- точные `admin` origin и redirect URI;
- OIDC client credentials через секретный канал Жене;
- allowlisted Telegram OIDC subject Сани;
- подтверждение DNS/TLS `admin.oknotika.ru`;
- путь к encrypted off-host backup.

## Deferred production activation gates

These are intentionally not executable in the credential-free implementation run and must remain unchecked in the deployment runbook, not in the implementation task checklist:

- create/configure the dedicated Telegram Web Login application and exact production redirect URI;
- inject OIDC credentials and the allowlisted Telegram subject through the server secret mechanism;
- run one real Telegram login/logout/revocation rehearsal;
- run `nginx -t`, systemd verification and live smoke tests on Zhenya's Linux host;
- configure the real encrypted off-host restic destination and perform the production restore drill;
- switch production symlinks only after explicit deployment approval.
