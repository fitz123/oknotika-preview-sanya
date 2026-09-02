# ОКНОТИКА — production-candidate handoff сайта

Версия включает актуальный многостраничный публичный сайт, финальную команду из девяти человек с шестью подтверждёнными августовскими портретами, продуктовые страницы, сравнение версий АР, раздел «Новости» и закрытый редактор еженедельного «Дайджеста недели» с одним локальным аккаунтом.

Публичный сайт остаётся статическим. Node.js-сервис нужен только авторизованному редактору: он хранит черновики в SQLite, генерирует immutable article release и атомарно переключает symlink. Остановка админки не останавливает сайт и не скрывает уже опубликованные статьи.

RC-пакет передаётся Жене для развёртывания, но сам production не активирует. Реальный local login/rotation, Tuesday ingestion smoke, Linux-проверки nginx/systemd, DNS/TLS и encrypted off-host backup остаются обязательными gates из `deploy/README_ZHENYA.md`.

## Состав проекта

- `index.html` и продуктовые каталоги — статический публичный сайт;
- `articles/` — статический fallback рубрики, detail-страница Al Bahr и `latest.json` для главной;
- `admin-app/` — Node.js 24 / SQLite редактор, local password auth, preview и publisher;
- `deploy/` — nginx, hardened systemd units, backup/restore scripts и runbook для Жени;
- `release-evidence/` — baseline, approval sheets и результаты beta-rehearsal;
- `release/` — versioned secret-free ZIP, checksums, manifest, release notes и inventory изменений;
- `ALUMINUM_SOURCES.md` — claim-level источники Schüco и provenance оригинальных визуалов;
- `IMAGE_SOURCES.md` — источники и права на опубликованные изображения.

Публичные разделы: `/aluminum/`, `/pvc/`, `/wood-stoller/`, `/carbon-glass/`, `/glass/`, `/protectapeel/`, `/oknotika-smart-window/` и `/articles/`. Публичной ссылки на админку нет.

## Локальный просмотр

Корень сайта нужно отдавать HTTP-сервером, а не открывать через `file://`, иначе загрузка `/articles/latest.json` на главной не воспроизводит production-поведение:

```bash
python3 -m http.server 8080
```

После запуска открыть `http://127.0.0.1:8080/`. Статические страницы не требуют npm-зависимостей.

## Content model «Новости» / «Дайджест недели»

Раздел фиксирован как «Новости», а weekly material помечается «Дайджест недели». У статьи обязательны title, publication date, lead, ограниченный Markdown body из 3–5 редакционных пунктов, cover и alt; список из 1–20 уникальных источников допускает только точные `https:` URL и никогда не загружается сервером. Время хранится в UTC и показывается в `Europe/Moscow`.

Tuesday research run в 12:00 MSK создаёт или обновляет один private draft через отдельный draft-only bearer credential. `issueId` и монотонный `contentVersion` делают retry идемпотентным; ручная правка, публикация или withdrawal блокирует машинную перезапись конфликтом. В пятницу к 18:00 MSK Саня проверяет draft и публикует его только явным действием из локально аутентифицированной editor session. Точный contract и encrypted caller path описаны в `docs/WEEKLY_INGESTION.md`.

Финальный CTA использует четыре глобальных validated destinations с точными non-secret defaults: Telegram `https://t.me/oknotika`, YouTube `https://youtube.com/@oknotika`, VK `https://vk.ru/oknotika` и отдельный FUTUCHAT `https://t.me/FUTU_CHAT`. Telegram зафиксирован; остальные три поля можно независимо изменить или очистить в редакторе без code edit. Явно подтверждённое сохранение строит и атомарно активирует новый immutable article release, поэтому уже опубликованные дайджесты обновляются сразу; очищенная optional-площадка публично не рендерится.

Slug создаётся при первом сохранении из title как lowercase ASCII. Collision получает суффикс `-2`, `-3` и далее. После создания slug и публичный URL неизменяемы, даже если title изменён.

Каждое сохранение создаёт immutable revision. Working revision/state и public revision/state хранятся отдельно: сохранение нового draft не меняет уже опубликованную страницу. Только успешный atomic publish/withdraw после active-symlink switch обновляет public pointer. Снятая статья исчезает из listing и `latest.json`, её прежний detail URL отдаёт generated страницу с реальным HTTP 410 через deterministic nginx marker, а latest переключается на предыдущую публикацию.

Cover принимается только как фактический JPEG, PNG или WebP до 10 MB и 40 MP. Сервис проверяет сигнатуру/MIME и decoder limits, перекодирует изображение, удаляет EXIF и хранит original и unpublished derivatives вне nginx document root. В публичный release попадают только validated hashed derivatives.

SQLite schema находится в `admin-app/migrations/`; renderer и publisher — в `admin-app/src/render/`. На чистом production старый Al Bahr идемпотентно импортируется командой `npm run bootstrap-content` как первая опубликованная revision и active release; exact procedure находится в deploy runbook. Golden-render test защищает прежний URL и видимый контент.

## Локальный аккаунт и доступ

В MVP настроен один editor без CRUD/RBAC. Доступ определяется точным локальным username и стойким versioned scrypt password record из root-controlled файлов.

Перед включением admin vhost Женя запускает root-only `deploy/docker/configure-local-credentials.sh`. Helper скрыто спрашивает пароль дважды, передаёт его hasher только через stdin, делает SQLite snapshot, атомарно переключает username/hash generation и отзывает sessions при rotation. Пароль и hash не записываются в Git, ZIP, Compose environment, shell history, SQLite, logs или открытые evidence. Пошаговая процедура: `admin-app/ENROLLMENT.md`; production-порядок, rotation, rollback и вывод старого relay: `deploy/docker/README_ZHENYA.md`.

Авторизация использует Authorization Code Flow, PKCE S256, одноразовые server-side `state`, `nonce` и verifier, pinned signing algorithm и bounded JWKS refresh. Сессия opaque и server-side; cookie — `__Host-`, Secure, HttpOnly, SameSite=Lax. Изменяющие запросы требуют CSRF, exact Origin и Fetch Metadata checks.

## Editor flow

1. Tuesday ingestion автоматически создаёт private draft weekly issue; его credential не может читать private listing, preview, publish, withdraw, restore или rollback.
2. Редактор входит локальным логином/паролем, проверяет «Дайджест недели» и при необходимости создаёт или редактирует материал с обязательными полями, cover, источниками и social destinations.
3. Сохранение создаёт новый draft/revision; optimistic revision check не даёт затереть параллельную или машинную правку.
4. Preview открывается только в текущей authenticated session по unguessable URL, с `no-store` и `noindex`.
5. Publish требует явного подтверждения. Publisher сначала получает crash-recoverable single lock, строит один immutable prospective snapshot, рендерит и валидирует staging release, затем атомарно переключает `article-releases/active` и только после switch синхронизирует public state/audit в DB. Ошибка до switch не меняет editorial/public state; startup reconciliation завершает post-switch crash.
6. Withdraw также требует подтверждения и создаёт новый release с 410 для прежнего URL.
7. Editorial restore копирует выбранную старую revision в новый draft. Operational rollback отдельно переключает весь active article release, остаётся operator-only, отсутствует в editor HTTP API и запускается Женей только через root-controlled `npm run rollback-release`. Оба действия пишутся в audit log.

Главная не переписывается при публикации: `js/latest-fact.js` читает `/articles/latest.json`, сохраняя статический fallback при сетевой ошибке.

## Запуск и проверка admin-app

Требуется exact Node.js `24.18.0`; bundled SQLite — `3.53.1`. npm-версии закреплены в `admin-app/package-lock.json`.

```bash
cd admin-app
npm ci
npm run lint
npm test
npm run test:security
npm run build
npm run render:fixture
```

Production-конфигурация обязательна и fail-closed. `admin-app/.env.example` содержит только non-secret paths/origins; local username/password hash, weekly-ingestion и backup secrets передаются только через защищённые credential files. Runtime DB, uploads, previews, sessions, Tuesday payloads и generated releases не должны находиться в Git или публичном document root.

## Полная локальная валидация

```bash
git diff --check
python3 scripts/check_v227_allowlist.py --repo . --baseline 5364ff160ffa9b8e9f2d0998a5eef1cf6cd3f5ed
python3 scripts/check_local_refs.py .
python3 scripts/check_team_dom.py index.html release-evidence/team-release-evidence.json
python3 scripts/check_public_claims.py .
python3 scripts/check_aluminum_sources.py ALUMINUM_SOURCES.md aluminum/index.html
python3 scripts/check_deploy_package.py .
python3 scripts/check_final_documentation.py .
node --check script.js
node --check js/latest-fact.js
python3 -m unittest discover -s tests -v
```

Generated article fixture проверяется после `npm run render:fixture`:

```bash
python3 scripts/check_generated_articles.py var/test-release
python3 scripts/scan_release_zip.py release/oknotika-final.zip
```

Linux/production gates не заменяются локальной macOS-проверкой: перед активацией обязательны DNS/TLS, pinned runtime, encrypted credentials, enrollment Сани, `nginx -t`, `systemd-analyze verify`, live auth/public/weekly-ingestion smoke и restore из реального encrypted off-host restic repository.

## Перегенерация портретов и visual evidence

Private raw inputs остаются только в `.tmp-inputs/team-shoot/` вне Git и ZIP; исходники с EXIF нельзя копировать в public/release directories. Нужны exact Pillow `12.2.0`, Playwright CLI `1.58.2` и Chromium `145.0.7632.6`. После отдельного утверждения нового approval sheet выполнить из корня:

```bash
python3 tools/team-portraits/create_final_portraits.py \
  --repo . \
  --raw-dir .tmp-inputs/team-shoot
```

`--skip-approval-capture` допустим только для локальной проверки crop/output и не заменяет финальные desktop/mobile evidence. Команда проверяет exact raw SHA-256, формат/EXIF, 4:5 crop, версии инструментов, общий byte budget и записывает только оптимизированные JPEG/WebP плюс `release-evidence/team-*`. Любая смена кадра, crop, роли или прав требует нового явного approval перед release rebuild.

## Release и эксплуатация

Текущий secret-free candidate — `v2.29.0-rc.2`: зафиксированный implementation SHA, baseline SHA, количество файлов и archive SHA-256 находятся в `release/release-manifest-v2.29.0-rc.2.json`. Проверяемые checksums — в `release/SHA256SUMS`; полный список отличий release payload от V2.27 — в `release/CHANGED_FILES-v2.29.0-rc.2.txt` и внутри ZIP как `CHANGED_FILES.txt`. `v2.29.0-rc.1` сохранён без изменений как исторический handoff Жене и не является источником нового CI/CD deploy.

Перед распаковкой:

```bash
cd release
sha256sum -c SHA256SUMS
```

Установка, activation будущего protected `main` и GitHub Environment `production`, exact deploy secret names, runtime layout, routine deploy/evidence, password rotation, миграции, backup/restore, first local setup, emergency rollback и отдельные content/marketing/application rollback описаны в `deploy/README_ZHENYA.md`. Результаты локальной проверки находятся в `release-evidence/qa/`; live local-login gate выполняется на VPS по Docker runbook.

Архитектурный ADR намеренно не создан: план требует отдельного подтверждения пользователя до фиксации решения в `docs/adr/`.
