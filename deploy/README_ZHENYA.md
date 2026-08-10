# Развёртывание ОКНОТИКИ для Жени

Этот пакет разворачивает статический публичный сайт с разделом «Новости» и отдельный закрытый редактор «Дайджеста недели». Публичный nginx не зависит от доступности Node.js: `/articles/` читается из одного immutable release через symlink `active`. В репозитории и release ZIP нет production credentials, Telegram subject, SQLite, uploads, previews, Tuesday payloads или restic password.

## Зафиксированный runtime

- Node.js: ровно `24.18.0` (Krypton LTS), major 24 закреплён в `admin-app/package.json`, exact patch — в `deploy/release-manifest.json`.
- SQLite: встроенный в этот Node.js `node:sqlite`, версия `3.53.1`; отдельного динамического SQLite npm-пакета нет.
- npm-библиотеки: только версии из `admin-app/package-lock.json`; установка исключительно `npm ci`, без обновления lockfile на сервере.
- restic: системный пакет поддерживаемого Linux-дистрибутива. Репозиторий и пароль передаются только systemd credentials.
- Host tools: `bash`, GNU `coreutils` (`sha256sum`, `realpath`, `install`, `mv -T`), `util-linux` (`flock`), `curl`, `ripgrep` (`rg`), `python3`, `nginx`, `systemd` и `restic`. До распаковки проверить `command -v bash sha256sum realpath install flock curl rg python3 nginx systemctl systemd-analyze restic`.

Архив Node.js берётся с `https://nodejs.org/dist/v24.18.0/`. Перед установкой сверить архив с опубликованным `SHASUMS256.txt` и подписью релиза, затем установить в `/opt/node-v24.18.0`. `deploy/scripts/preflight.sh` откажется запускать сервис с другим Node или bundled SQLite.

## Runtime layout и права

```text
/opt/node-v24.18.0/                         root:root, read-only runtime
/opt/oknotika-admin/releases/<sha>/         root:root, immutable application release
/opt/oknotika-admin/current -> releases/... atomic application symlink
/srv/oknotika/releases/<sha>/               root:root, immutable marketing release
/srv/oknotika/current -> releases/...       atomic marketing symlink
/var/lib/oknotika-admin/db/                 0700, SQLite + migration backups
/var/lib/oknotika-admin/uploads/            0700, originals + private derivatives
/var/lib/oknotika-admin/previews/           0700, authenticated previews
/var/lib/oknotika-admin/article-releases/   0750, published immutable releases + active
/var/lib/oknotika-admin/backups/            0700, verified online snapshot and lock
/run/oknotika-admin/app.sock                oknotika-admin:www-data, 0660
```

Создать непривилегированного пользователя без shell и home. В unit задано `User=oknotika-admin`, `Group=www-data`: private paths остаются `0700/0600`, а published article releases создаются с group read. Node после bind выставляет socket `0660`. Не добавлять nginx к группе, имеющей доступ к `db`, `uploads` или `previews`.

## Активация production CI/CD

Контур в `.github/workflows/deploy-production.yml` намеренно не активен на текущем `master`: он реагирует только на push будущего защищённого `main`, повторно запускает secret-free CI, строит один bundle по exact `github.sha`, проверяет его checksum и ждёт ручного допуска GitHub Environment `production`. Pull request, feature branch, tag и ручной запуск не могут вызвать deploy. Environment approval не заменяет server bootstrap и production gates ниже.

### Root-controlled server primitive и deploy account

Женя выполняет этот раздел из root-сессии при первом bootstrap и повторяет установку обоих helper из exact reviewed commit перед одобрением любого run, который меняет один из них. Repository workflow не устанавливает и не обновляет root-owned файлы:

```bash
sudo useradd --system --create-home \
  --home-dir /var/lib/oknotika-deploy \
  --shell /bin/bash oknotika-deploy
sudo install -d -o oknotika-deploy -g oknotika-deploy -m 0750 \
  /var/lib/oknotika-deploy/incoming
sudo install -d -o root -g root -m 0755 /usr/local/sbin
sudo install -o root -g root -m 0755 \
  deploy/cicd/oknotika-deploy /usr/local/sbin/oknotika-deploy
sudo install -o root -g root -m 0755 \
  deploy/scripts/install-marketing.sh /usr/local/sbin/oknotika-install-marketing
```

В `/var/lib/oknotika-deploy/.ssh/authorized_keys` установить только отдельный public key GitHub deploy credential с OpenSSH option `restrict`; каталог должен быть `0700`, файл `0600`, владелец `oknotika-deploy`. Не использовать личный ключ, agent forwarding или ключ от backup/runtime account. Restricted account получает запись только в `/var/lib/oknotika-deploy/incoming` и следующий root-owned sudoers rule:

```sudoers
oknotika-deploy ALL=(root) NOPASSWD: /usr/local/sbin/oknotika-deploy *
```

Проверить rule через `visudo -cf`, затем из отдельной сессии подтвердить, что `sudo -n -l` не разрешает других root-команд. Wildcard передаёт аргументы только этому root-owned parser: primitive принимает ровно bundle/checksum/release SHA, требует файлы непосредственно в fixed incoming directory, проверяет SHA, archive boundary и internal manifest. До staging primitive сравнивает SHA-256 обоих установленных root-owned helper с их reviewed copies внутри bundle и fail-closed требует ручную переустановку из exact commit при расхождении. Primitive запускает bundle `preflight.sh` и `smoke-test.sh` только от `oknotika-admin`, а public allowlist устанавливает через отдельно сверенный root-owned `/usr/local/sbin/oknotika-install-marketing`; artifact-controlled shell не исполняется с root privileges. Не давать deploy account право менять оба `/usr/local/sbin/oknotika-*` helper, application/marketing roots, systemd units или credentials.

### GitHub Environment, secrets и protected main

Создать Environment с точным именем `production`: required reviewer — Женя, self-approval отключён, deployment branches ограничены только `main`. В Environment создать только пять значений:

- `OKNOTIKA_DEPLOY_HOST` — DNS name или IPv4 production SSH endpoint;
- `OKNOTIKA_DEPLOY_PORT` — numeric SSH port;
- `OKNOTIKA_DEPLOY_USER` — ровно выделенный account `oknotika-deploy`;
- `OKNOTIKA_DEPLOY_SSH_PRIVATE_KEY` — private half отдельного restricted deploy key;
- `OKNOTIKA_DEPLOY_SSH_KNOWN_HOSTS` — заранее независимо сверенная exact host-key line; `ssh-keyscan` в workflow запрещён.

Telegram OIDC, `weekly-ingest-token`, restic credentials, editor identity и runtime data в GitHub не переносятся: они остаются encrypted systemd credentials на сервере. Secret values не вставлять в repository variables, Actions logs, workflow inputs или release evidence.

Миграция с текущего `master` выполняется оператором только после merge утверждённых feature PR и не входит в этот пакет:

1. Создать `main` из exact approved commit, проверить SHA и сделать его default branch; старый `master` не удалять до проверки ссылок и automation.
2. Защитить `main`: changes only through pull requests, минимум один независимый approval, dismiss stale approvals, require conversation resolution, запрет force-push/deletion и required check `CI / Secret-free validation`.
3. Ограничить изменение `.github/workflows/**`, `deploy/cicd/**`, `deploy/scripts/install-marketing.sh` и этого runbook обязательным review Жени через repository ownership policy.
4. Настроить `production` Environment как выше. До этого шага не добавлять deploy secrets; после настройки выполнить только reviewed no-op connection rehearsal, не production activation.

### Первый bootstrap, routine deploy и evidence

`oknotika-deploy` fail-closed отклоняет сервер без обоих existing `current` symlink. Первый application/marketing release устанавливает Женя вручную по разделам ниже из проверенного `v2.29.0-rc.2`, затем настраивает systemd credentials, nginx, enrollment, backup/restore и smoke gates. Только после работающих `/opt/oknotika-admin/current` и `/srv/oknotika/current` разрешать первый workflow run.

Routine deploy: reviewed PR проходит CI → PR merges в protected `main` → workflow повторяет CI и строит artifact `oknotika-ci-<commit SHA>` → Женя сверяет commit/run и одобряет `production` → helper проверяет local checksum и pinned host identity, передаёт только `<sha>.zip` и `<sha>.zip.sha256` → root primitive проверяет и активирует application/marketing → после restart делает bounded readiness retries и public/admin smoke подтверждает результат. Никогда не одобрять run для SHA, которого нет в protected `main`.

Для каждого run сохранить вне release ZIP: GitHub run URL/ID, exact commit SHA, artifact SHA-256, reviewer/timestamp, pre/post application и marketing symlink targets, primitive exit status, smoke result и rollback result. Не сохранять key material, host credentials, private payload, editor identity, response bodies, DB/uploads/previews или environment dump.

При ошибке или `SIGHUP`/`SIGINT`/`SIGTERM` после switch primitive автоматически возвращает ровно captured application/marketing targets, перезапускает service и повторяет smoke; article/content symlink не меняется. После подтверждённого rollback он удаляет только два failed `<sha>` target, сохраняя incoming bundle/checksum и logs как evidence, поэтому exact reviewed SHA можно повторить без ручной очистки. При неуспешном rollback failed targets сохраняются для расследования. Если проблема обнаружена после успешного workflow, Женя под deploy lock вручную проверяет предыдущие immutable application/marketing directories, атомарно возвращает оба relative `current` symlink, перезапускает `oknotika-admin.service` и выполняет `smoke-test.sh`. Если rollback smoke не проходит, остановить admin write surface, сохранить evidence и перейти к Emergency disable; не пытаться менять content release как часть application/marketing rollback.

## Установка application release

1. Проверить checksum secret-free ZIP и release SHA из release notes.
2. Распаковать в новый `/opt/oknotika-admin/releases/<sha>`. Старый каталог не изменять.
3. В `admin-app/` выполнить pinned Node: `npm ci`, затем локальные gates `npm run lint`, `npm test`, `npm run test:security`, `npm run build`, `npm run render:fixture`. Для production artifact разрешено удалить devDependencies только после этих проверок через `npm prune --omit=dev`.
4. Скопировать `deploy/config/oknotika-admin.env.example` в `/etc/oknotika-admin/oknotika-admin.env`, поставить `root:oknotika-admin` и `0640`, заменить только подтверждённые canonical origins. Release SHA для migration/backup evidence автоматически берётся из immutable application release path; credentials в этот файл не писать.
5. Атомарно переключить `/opt/oknotika-admin/current` через новый относительный symlink и `mv -T`. Не удалять предыдущий release до следующего успешного backup/restore drill.

## Установка marketing release

Marketing document root получает только публичный allowlist; копировать весь ZIP в `/srv/oknotika/current` запрещено, иначе backend/deploy sources окажутся под nginx root.

1. Проверить `sha256sum -c release/SHA256SUMS`, распаковать ZIP во временный root-only каталог и проверить, что payload root один.
2. Взять 40-символьный implementation SHA из проверенного release manifest и выполнить:

```bash
deploy/scripts/install-marketing.sh \
  --source /var/tmp/oknotika-unpack/oknotika-final-v2.29.0-rc.2 \
  --release-sha "$IMPLEMENTATION_SHA" \
  --marketing-root /srv/oknotika
```

Скрипт fail-closed проверяет обязательные public paths и отсутствие symlinks, копирует только HTML/CSS/JS/images/product/article fallback в новый root-owned immutable `/srv/oknotika/releases/<sha>`, выставляет `0755/0644` и атомарно переключает относительный `current`. До и после switch выполнить локальный `curl --resolve` для `/`, `/aluminum/` и `/articles/`; при ошибке вернуть предыдущий marketing symlink по процедуре rollback.

Для production используются ровно `https://oknotika.ru`, `https://admin.oknotika.ru` и `https://admin.oknotika.ru/auth/callback`. Приложение повторно валидирует origins и callback; nginx перезаписывает `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` и `X-Forwarded-For`. Backend принимает эти заголовки только в точном single-value виде, а доступ к socket ограничен локальными правами.

## Секреты и rotation

Создать encrypted credentials в `/etc/credstore.encrypted/` с помощью `systemd-creds encrypt --name=<name> - /etc/credstore.encrypted/<name>.cred`:

- `telegram-oidc-client-id`;
- `telegram-oidc-client-secret`;
- `weekly-ingest-token` — общий bearer token сервера и Tuesday caller, минимум 32 случайных печатных ASCII-символа без пробелов и запятых;
- `restic-repository` — строка encrypted off-host repository;
- `restic-password` — отдельный сильный пароль репозитория.

Исходные значения принимать только по согласованному секретному каналу, не вставлять в shell history, ticket, Telegram или journal. Файлы credentials — `root:root 0600`. Units используют `LoadCredentialEncrypted`; Node читает временные файлы из `%d`, а restic получает `RESTIC_PASSWORD_FILE` и repository file.

Rotation Telegram: создать новые credential-файлы под временными именами, проверить ownership/mode, остановить admin, атомарно заменить `.cred`, запустить сервис и выполнить login/logout/revocation gate. Старый client secret отозвать только после успешной проверки. Rotation restic: сначала создать и проверить новый repository/password и полный backup/restore drill; старый repository сохранять до подтверждённого restore и истечения retention.

Weekly ingestion использует отдельный `weekly-ingest-token`, который не даёт
Telegram-сессию и принимается только на draft-only endpoint. Server unit читает
его из `%d/weekly-ingest-token`; cron-side research unit должен загрузить то же
значение как собственный encrypted systemd credential и собрать Authorization
header только в памяти. Контракт, version/conflict rule, rotation и запрет
секрета в argv/env/log описаны в `docs/WEEKLY_INGESTION.md`.

## Tuesday ingestion и draft-only smoke

Tuesday research unit запускается в 12:00 MSK после генерации presenter PDF. Он передаёт тот же проверенный пакет в `POST /api/ingestion/weekly-drafts`, но не получает Telegram-сессию и не может публиковать. В пятницу к 18:00 MSK Саня входит через Telegram, проверяет источники и preview, при необходимости редактирует черновик и сам нажимает publish.

До первого live smoke должны существовать: enrolled editor Сани, зарегистрированный reusable private cover asset, encrypted `weekly-ingest-token` одновременно у admin service и Tuesday caller, а также закрытый JSON payload по контракту `docs/WEEKLY_INGESTION.md`. Payload, cover и response body не сохранять в release evidence или journal.

После enrollment Саня утверждает одну reusable branded cover. Женя помещает исходник в закрытый путь вне public root, доступный `oknotika-admin` только на время команды, и регистрирует его через тот же validated image pipeline, что использует редактор:

```bash
sudo systemd-run --pty --wait --collect --unit=oknotika-register-weekly-cover \
  --property=User=oknotika-admin --property=Group=www-data --property=UMask=0027 \
  --property=WorkingDirectory=/opt/oknotika-admin/current/admin-app \
  --property=Environment=PATH=/opt/node-v24.18.0/bin:/usr/bin:/bin \
  --property=ReadWritePaths=/var/lib/oknotika-admin \
  /opt/node-v24.18.0/bin/npm \
  run register-weekly-cover -- \
  --database /var/lib/oknotika-admin/db/admin.sqlite \
  --uploads-root /var/lib/oknotika-admin/uploads \
  --public-root /srv/oknotika/current \
  --cover /private/path/to/approved-weekly-cover.png
```

Команда требует ровно одного enabled editor, проверяет JPEG/PNG/WebP, decoder/pixel limits, перекодирует в WebP без EXIF и выводит только `assetId`, media type и размеры. Женя переносит numeric `assetId` в root-owned private configuration Tuesday payload generator; это не credential, но его не публикуют в release evidence. Caller вставляет его как `coverAssetId` и не получает upload/list authority. Исходник из временного закрытого пути удаляется оператором после сверки зарегистрированного результата. При смене обложки повторить процедуру, атомарно заменить ID в private caller configuration и выполнить smoke до отказа от старого ID.

Из Tuesday research unit, где `LoadCredentialEncrypted=weekly-ingest-token` уже задаёт `CREDENTIALS_DIRECTORY`, выполнить:

```bash
/opt/node-v24.18.0/bin/node \
  /opt/oknotika-admin/current/deploy/scripts/smoke-weekly-ingestion.mjs \
  --admin-url https://admin.oknotika.ru \
  --payload-file /private/path/to/generated-weekly-payload.json
```

Скрипт читает token только из credential file, отправляет payload и его identical retry, требует idempotent результат и проверяет, что bearer credential получает HTTP 401 на listing и operational rollback. В stdout попадает только безопасный pass summary без token, payload, article/revision identifiers или response body. После pass Саня должен увидеть материал как `Черновик` в «Новости», а публичные `/articles/` и `/articles/latest.json` не должны измениться до его ручной публикации.

Для изолированной local/oneshot-диагностики допустим явный `--token-file /root-controlled/path/weekly-ingest-token`: это override только пути к credential file, не значения token. Файл должен оставаться вне Git и public root с доступом `root:root 0600`; token запрещено передавать в argv. В production штатный путь выше через `LoadCredentialEncrypted` и `CREDENTIALS_DIRECTORY` обязателен.

## nginx

Установить:

- `deploy/nginx/00-oknotika-zones.conf` → `/etc/nginx/conf.d/00-oknotika-zones.conf`;
- public/admin configs → `/etc/nginx/sites-available/`;
- snippets → `/etc/nginx/snippets/oknotika-*-security-headers.conf`.

Public vhost выдаёт `/articles/` только из `/var/lib/oknotika-admin/article-releases/active/articles/`: HTML/JSON revalidate, hashed media immutable. Admin vhost ограничивает JSON body до 1 MB, разрешает 10 MB только exact upload route с двумя одновременными upload connections, имеет отдельные login/general rate limits, `no-store`, CSP, HSTS, nosniff, `frame-ancestors 'none'` и проксирует только в `/run/oknotika-admin/app.sock`.

Не включать symlink admin vhost до выдачи TLS, настройки credentials и enrollment. На Linux обязательно выполнить `nginx -t`; reload делать только после успешного результата.

## systemd

Установить units из `deploy/systemd/` в `/etc/systemd/system/`, выполнить `systemctl daemon-reload` и проверить:

```bash
systemd-analyze verify /etc/systemd/system/oknotika-admin.service
systemd-analyze verify /etc/systemd/system/oknotika-admin-backup.service
systemd-analyze verify /etc/systemd/system/oknotika-admin-backup.timer
systemd-analyze verify /etc/systemd/system/oknotika-admin-backup.path
```

Service имеет empty capabilities, `NoNewPrivileges`, read-only system, private devices/tmp и запись только в `/var/lib/oknotika-admin` и `/run/oknotika-admin`. До старта он создаёт runtime directories, при наличии pending migration делает verified pre-migration SQLite backup и проверяет exact runtime/origins/credential files.

После credentials, verified enrollment, initial article bootstrap, nginx validation и restore gate включить units в таком порядке:

```bash
systemctl enable --now oknotika-admin.service
systemctl enable --now oknotika-admin-backup.timer
systemctl enable --now oknotika-admin-backup.path
systemctl is-enabled oknotika-admin.service oknotika-admin-backup.timer oknotika-admin-backup.path
systemctl is-active oknotika-admin.service oknotika-admin-backup.timer oknotika-admin-backup.path
journalctl -u oknotika-admin.service -u oknotika-admin-backup.service --since=-10m
```

При неуспехе не включать admin vhost: `systemctl disable --now oknotika-admin-backup.path oknotika-admin-backup.timer oknotika-admin.service`, сохранить journal и выполнить соответствующий application/content rollback.

## Миграции и downgrade

Новые миграции должны быть additive/backward-compatible: новые nullable/default columns, новые таблицы и индексы; запрещены drop/rename/destructive rewrite в обычном релизе. `scripts/check_deploy_package.py` блокирует очевидные destructive SQL statements.

`pre-migrate-backup.sh` сначала сравнивает `schema_migrations` с миграциями нового release. Только при наличии pending migration он создаёт SQLite online snapshot в `db/migration-backups/`, выполняет `PRAGMA integrity_check` и пишет SHA-256. Имя детерминировано исходной/целевой схемой, migration fingerprint и release, поэтому рестарты повторно проверяют тот же snapshot, а не создают новые копии; сохраняются десять последних migration backups. Приложение применяет pending migrations транзакционно только после этого шага.

Breaking migration требует отдельного двухфазного плана и rehearsal:

1. На копии production backup восстановить pre-migration DB.
2. Открыть её предыдущим application release и выполнить его полный test/smoke набор.
3. Применить новый release к другой копии и проверить upgrade.
4. Для downgrade восстановить исходную pre-migration DB; никогда не запускать старый код на необратимо изменённой production DB.
5. Зафиксировать время; весь restore + application activation должен укладываться в RTO: 2 часа.

## Backup и restore

RPO: 24 часа плюс backup после каждого publish. RTO: 2 часа.

`oknotika-admin-backup.timer` запускает daily backup, а `oknotika-admin-backup.path` реагирует на atomic switch `article-releases/active`. `backup.sh` сначала получает тот же crash-recoverable publisher lock и под ним синхронизирует SQLite с active manifest, поэтому даже после падения publisher между symlink switch и DB finalize snapshot, immutable releases и active symlink не могут попасть в разные publication generations; отдельный backup `flock` не допускает два restic процесса. Затем скрипт создаёт online SQLite snapshot, проверяет его и передаёт restic:

- SQLite с audit events и site/release state;
- private originals и unpublished/published derivatives в `uploads/`;
- immutable article releases, их manifests, required public derivatives и active symlink.

Retention: 7 daily / 8 weekly / 12 monthly. После backup выполняются `restic forget --prune` и `restic check`. Ошибка любого этапа делает systemd unit failed и должна попасть в мониторинг journal.

Restore drill выполнять минимум после первоначальной настройки и после изменений backup topology. Через временный oneshot unit загрузить те же encrypted restic credentials и запустить:

```bash
/opt/oknotika-admin/current/deploy/scripts/restore-drill.sh \
  --target /var/tmp/oknotika-restore-drill-YYYYMMDD
```

Target обязан быть пустым и изолированным. Скрипт проверяет SQLite integrity, чтение audit state, hashes release manifests, exact active symlink target, `site_state`, соответствие `site_social_links` active manifest, completed release и все referenced article/revision rows. Затем отдельно запустить downgrade rehearsal на копии pre-migration DB. Результат, snapshot ID, длительность и удаление временных данных записать в release evidence. Production restore разрешён только в согласованное окно: остановить admin, сохранить повреждённое состояние отдельно, восстановить DB/uploads/article releases, проверить владельцев и hashes, затем запустить reconciliation и smoke tests.

## Первичное подключение редактора

1. Создать отдельное corporate Telegram Web Login приложение с exact production origin/callback, подготовить DNS/TLS и encrypted credentials. Admin vhost ещё не включать.
2. Один раз выполнить `systemctl start oknotika-admin.service`, проверить `systemctl is-active oknotika-admin.service` и journal, затем `systemctl stop oknotika-admin.service`. Это создаёт runtime layout, выполняет preflight/migrations и pre-migration backup без включения admin vhost.
3. На root terminal запустить интерактивный verified bootstrap с теми же credentials:

```bash
systemd-run --pty --wait --collect --unit=oknotika-bootstrap-editor \
  --property=User=oknotika-admin --property=Group=www-data \
  --property=WorkingDirectory=/opt/oknotika-admin/current/admin-app \
  --property=EnvironmentFile=/etc/oknotika-admin/oknotika-admin.env \
  --property=Environment=PATH=/opt/node-v24.18.0/bin:/usr/bin:/bin \
  --property=Environment=TELEGRAM_OIDC_CLIENT_ID_FILE=%d/telegram-oidc-client-id \
  --property=Environment=TELEGRAM_OIDC_CLIENT_SECRET_FILE=%d/telegram-oidc-client-secret \
  --property=LoadCredentialEncrypted=telegram-oidc-client-id \
  --property=LoadCredentialEncrypted=telegram-oidc-client-secret \
  --property=ReadWritePaths=/var/lib/oknotika-admin \
  /opt/node-v24.18.0/bin/npm run bootstrap-editor
```

4. Открыть выданный one-time authorization URL в браузере Сани. После redirect вставить полный callback URL только в prompt, не в shell command/history. Скрипт выполняет code+PKCE exchange и полную проверку ID token, затем показывает локально verified `sub`/fingerprint. Сверить identity с Саней отдельным каналом и ввести `ENROLL-<fingerprint>`.
5. Сохранить в evidence только timestamp, approvers и fingerprint, не callback/code/token/subject. Процедура подробно описана в `admin-app/ENROLLMENT.md`.
6. После включения admin vhost Саня входит в «Новости» и сверяет четыре точных non-secret default: Telegram `https://t.me/oknotika`, YouTube `https://youtube.com/@oknotika`, VK `https://vk.ru/oknotika` и отдельный FUTUCHAT `https://t.me/FUTU_CHAT`. При upgrade с active schema-3 release startup сначала reconciles прежний manifest, затем один раз атомарно активирует pending defaults в новом schema-4 release; database-only состояние не считается применённым. Telegram должен быть readonly; очищенная optional-площадка не должна показываться публично. Затем выполнить draft-only ingestion smoke из предыдущего раздела.

Удаление доступа: остановить admin, сделать verified backup, выполнить `npm run disable-editor -- --database /var/lib/oknotika-admin/db/admin.sqlite`, запустить service и убедиться, что старые sessions отозваны и вход запрещён. Для нового subject требуется reviewed maintenance change; автоматической замены editor/RBAC нет.

## Инициализация первой article release

После enrollment и marketing install, но до включения public/admin vhosts, импортировать packaged Al Bahr как первую published revision. Команда копирует reviewed JPEG из public payload в private uploads, идемпотентно создаёт article/revision, валидирует immutable release и переключает `article-releases/active`:

```bash
sudo systemd-run --pty --wait --collect --unit=oknotika-bootstrap-content \
  --property=User=oknotika-admin --property=Group=www-data --property=UMask=0027 \
  --property=WorkingDirectory=/opt/oknotika-admin/current/admin-app \
  --property=Environment=PATH=/opt/node-v24.18.0/bin:/usr/bin:/bin \
  --property=ReadWritePaths=/var/lib/oknotika-admin \
  /opt/node-v24.18.0/bin/npm \
  run bootstrap-content -- \
  --database /var/lib/oknotika-admin/db/admin.sqlite \
  --releases-root /var/lib/oknotika-admin/article-releases \
  --uploads-root /var/lib/oknotika-admin/uploads \
  --public-origin https://oknotika.ru \
  --cover /srv/oknotika/current/articles/assets/e794ac9b2fc096b47e5a406d.jpg
```

Перед командой сделать verified DB backup. После неё проверить `readlink /var/lib/oknotika-admin/article-releases/active`, `manifest.json`, `/articles/`, Al Bahr URL и `/articles/latest.json`; повторный запуск обязан сообщить `already complete` и не создавать вторую статью/release. При ошибке не включать article nginx location; восстановить backup и удалить только незавершённые staging-данные в согласованное окно.

## Emergency disable

При подозрении на компрометацию:

1. `systemctl stop oknotika-admin.service` и отключить admin vhost symlink; после `nginx -t` reload nginx.
2. Публичный vhost и `article-releases/active` не переключать: сайт и текущие «Новости» продолжают работать статически.
3. Сохранить journal/audit evidence в защищённое хранилище, отозвать Telegram credentials, отключить editor и его sessions.
4. Сделать forensic copy, восстановить доверенный application release и DB/uploads из проверенного snapshot, затем повторить enrollment и все security gates.

## Раздельные rollback procedures

Content rollback: в закрытом редакторе выбрать старую immutable редакцию и вернуть её как новый draft, проверить preview и опубликовать. Operational rollback всей рубрики отсутствует в editor HTTP API и доступен только из root-controlled operator shell. Женя выбирает exact previous completed article release, останавливает admin write surface, запускает CLI от service user и возвращает сервис:

```bash
sudo systemctl stop oknotika-admin.service
sudo systemd-run --pty --wait --collect --unit=oknotika-rollback-release \
  --property=User=oknotika-admin --property=Group=www-data --property=UMask=0027 \
  --property=WorkingDirectory=/opt/oknotika-admin/current/admin-app \
  --property=Environment=PATH=/opt/node-v24.18.0/bin:/usr/bin:/bin \
  --property=ReadWritePaths=/var/lib/oknotika-admin \
  /opt/node-v24.18.0/bin/npm \
  run rollback-release -- \
  --database /var/lib/oknotika-admin/db/admin.sqlite \
  --releases-root /var/lib/oknotika-admin/article-releases \
  --public-origin https://oknotika.ru \
  --release-id EXACT_COMPLETED_RELEASE_ID
sudo systemctl start oknotika-admin.service
```

CLI принимает только safe release ID, требует completed DB record, валидирует immutable target, атомарно переключает `article-releases/active`, синхронизирует DB и пишет `release.rolled_back` без editor identity. После команды проверить active symlink, manifest, `/articles/`, `latest.json` и journal. Rollback не снимает durable publish/withdraw lock weekly issue: Tuesday credential не может перезаписать исторически опубликованный материал. Это не меняет application или marketing release.

Marketing rollback: выбрать предыдущий `/srv/oknotika/releases/<sha>`, проверить его checksum, создать рядом новый относительный symlink и атомарно выполнить `mv -T` в `/srv/oknotika/current`. Не трогать `/articles/`, DB или admin service; затем проверить главную и продуктовые страницы.

Application rollback с этой версии на предыдущую schema-3 application требует сначала вернуть совместимый active article release, пока `/opt/oknotika-admin/current` ещё указывает на новую application. Остановить admin, сделать verified DB backup, выбрать exact completed schema-2/schema-3 article release из состояния до FUTUCHAT (для schema 3 допустимы только старые поля Telegram/YouTube/VK и `vk.com`, не `vk.ru`) и выполнить guarded rollback:

```bash
sudo systemd-run --pty --wait --collect --unit=oknotika-prepare-app-rollback \
  --property=User=oknotika-admin --property=Group=www-data --property=UMask=0027 \
  --property=WorkingDirectory=/opt/oknotika-admin/current/admin-app \
  --property=Environment=PATH=/opt/node-v24.18.0/bin:/usr/bin:/bin \
  --property=ReadWritePaths=/var/lib/oknotika-admin \
  /opt/node-v24.18.0/bin/npm \
  run rollback-release -- \
  --database /var/lib/oknotika-admin/db/admin.sqlite \
  --releases-root /var/lib/oknotika-admin/article-releases \
  --public-origin https://oknotika.ru \
  --release-id EXACT_PRE_FUTUCHAT_RELEASE_ID \
  --application-schema 3
```

Флаг fail-closed отклоняет schema-4 release, FUTUCHAT, `vk.ru` и любой другой manifest, который предыдущая application не сможет прочитать. Только после успешной команды проверить `article-releases/active`, manifest и `/articles/`, атомарно вернуть `/opt/oknotika-admin/current` на предыдущий release и запустить service. Additive columns/tables migrations 006–007 старая application игнорирует. Если совместимого immutable article release нет, восстановить один согласованный pre-migration backup, содержащий одновременно DB, `article-releases/releases` и symlink `article-releases/active`; восстановление одной DB недостаточно. Публичный vhost остаётся доступен всё время.

## Локальные и production gates

Локально, без credentials и Linux services:

```bash
deploy/scripts/check-templates.sh
cd admin-app
npm ci
npm run lint
npm test
npm run test:security
npm run build
npm run render:fixture
```

Обязательные deferred production gates принадлежат Жене; credential-free package не является доказательством их выполнения:

- [ ] DNS/TLS: направить `oknotika.ru` и `admin.oknotika.ru` на production, выпустить валидные сертификаты и зарегистрировать единственный callback `https://admin.oknotika.ru/auth/callback`; admin vhost не открывать раньше.
- [ ] Pinned runtime: установить проверенный Node.js `24.18.0`, подтвердить bundled SQLite `3.53.1`, lockfile SHA-256 из `deploy/release-manifest.json` и выполнить `preflight.sh`.
- [ ] Encrypted credentials: загрузить отдельные OIDC client ID/secret, общий для admin/Tuesday caller `weekly-ingest-token`, off-host `restic-repository` и `restic-password` через `LoadCredentialEncrypted`; прямых secret values в env, argv и evidence быть не должно.
- [ ] Enrollment Сани: выполнить verified PKCE bootstrap из `admin-app/ENROLLMENT.md`, независимо сверить identity и сохранить только fingerprint/approvers/timestamp.
- [ ] Linux config: выполнить `nginx -t` и все четыре `systemd-analyze verify`, затем проверить enabled/active units, file ownership/modes и journal без credentials.
- [ ] Live auth: пройти реальный Telegram login, logout, replay rejection, non-allowlisted rejection, session revocation и credential rotation по `release-evidence/qa/PRODUCTION_OIDC_REHEARSAL.md`.
- [ ] Weekly ingestion: из credential-scoped Tuesday unit выполнить `smoke-weekly-ingestion.mjs` с реальным private payload, подтвердить identical retry, draft-only статус в «Новости» и отсутствие публичного изменения.
- [ ] Public smoke: выполнить `smoke-test.sh` на двух canonical HTTPS origins; для опубликованного weekly digest передать `--weekly-path` вместе с exact active `manifest.json`, проверить configured CTA и отсутствие очищенных optional CTA, после первого withdrawal повторить его с HTTP 410 path.
- [ ] Restore: настроить реальный encrypted off-host restic repository, сделать backup и isolated restore drill, проверить SQLite/releases/active symlink и уложиться в RPO 24 часа / RTO 2 часа.
- [ ] Activation: переключать production symlinks и включать vhosts только после явного разрешения на deployment; записать pass/fail gates и rollback decision вне ZIP без private identifiers.

Live gate после включения TLS/vhosts:

```bash
./deploy/scripts/smoke-test.sh \
  --base-url "$OKNOTIKA_PUBLIC_ORIGIN" \
  --admin-url "$OKNOTIKA_ADMIN_ORIGIN" \
  --weekly-path /articles/<published-weekly-slug>/ \
  --social-manifest /var/lib/oknotika-admin/article-releases/active/manifest.json
```

До первой weekly publication параметры `--weekly-path` и `--social-manifest` опустить. После неё оба обязательны: gate сверяет exact href/labels с active manifest и требует, чтобы очищенные YouTube, VK или FUTUCHAT отсутствовали. Первые shipped defaults отдельно сверяются на шаге enrollment; последующие подтверждённые изменения не должны ломать steady-state smoke. После первого реального withdrawal повторить smoke с `--withdrawn-path /articles/<slug>/`: gate требует HTTP 410 и generated gone body, а не только текст «410» при HTTP 200.

Если gate не проходит, не продолжать активацию: application symlink вернуть по Application rollback, marketing — только по Marketing rollback, а active article release менять только через Content/operational rollback.
