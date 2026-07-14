# Развёртывание ОКНОТИКИ для Жени

Этот пакет разворачивает статический публичный сайт и отдельный закрытый редактор. Публичный nginx не зависит от доступности Node.js: `/articles/` читается из одного immutable release через symlink `active`. В репозитории и release ZIP нет production credentials, Telegram subject, SQLite, uploads, previews или restic password.

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

## Установка application release

1. Проверить checksum secret-free ZIP и release SHA из release notes.
2. Распаковать в новый `/opt/oknotika-admin/releases/<sha>`. Старый каталог не изменять.
3. В `admin-app/` выполнить pinned Node: `npm ci`, затем локальные gates `npm run lint`, `npm test`, `npm run test:security`, `npm run build`, `npm run render:fixture`. Для production artifact разрешено удалить devDependencies только после этих проверок через `npm prune --omit=dev`.
4. Скопировать `deploy/config/oknotika-admin.env.example` в `/etc/oknotika-admin/oknotika-admin.env`, поставить `root:oknotika-admin` и `0640`, заменить только release SHA и подтверждённые canonical origins. Credentials в этот файл не писать.
5. Атомарно переключить `/opt/oknotika-admin/current` через новый относительный symlink и `mv -T`. Не удалять предыдущий release до следующего успешного backup/restore drill.

## Установка marketing release

Marketing document root получает только публичный allowlist; копировать весь ZIP в `/srv/oknotika/current` запрещено, иначе backend/deploy sources окажутся под nginx root.

1. Проверить `sha256sum -c release/SHA256SUMS`, распаковать ZIP во временный root-only каталог и проверить, что payload root один.
2. Взять 40-символьный implementation SHA из проверенного release manifest и выполнить:

```bash
deploy/scripts/install-marketing.sh \
  --source /var/tmp/oknotika-unpack/oknotika-final-v2.28.0-beta.1 \
  --release-sha "$IMPLEMENTATION_SHA" \
  --marketing-root /srv/oknotika
```

Скрипт fail-closed проверяет обязательные public paths и отсутствие symlinks, копирует только HTML/CSS/JS/images/product/article fallback в новый root-owned immutable `/srv/oknotika/releases/<sha>`, выставляет `0755/0644` и атомарно переключает относительный `current`. До и после switch выполнить локальный `curl --resolve` для `/`, `/aluminum/` и `/articles/`; при ошибке вернуть предыдущий marketing symlink по процедуре rollback.

Для production используются ровно `https://oknotika.ru`, `https://admin.oknotika.ru` и `https://admin.oknotika.ru/auth/callback`. Приложение повторно валидирует origins и callback; nginx перезаписывает `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` и `X-Forwarded-For`. Backend принимает эти заголовки только в точном single-value виде, а доступ к socket ограничен локальными правами.

## Секреты и rotation

Создать encrypted credentials в `/etc/credstore.encrypted/` с помощью `systemd-creds encrypt --name=<name> - /etc/credstore.encrypted/<name>.cred`:

- `telegram-oidc-client-id`;
- `telegram-oidc-client-secret`;
- `restic-repository` — строка encrypted off-host repository;
- `restic-password` — отдельный сильный пароль репозитория.

Исходные значения принимать только по согласованному секретному каналу, не вставлять в shell history, ticket, Telegram или journal. Файлы credentials — `root:root 0600`. Units используют `LoadCredentialEncrypted`; Node читает временные файлы из `%d`, а restic получает `RESTIC_PASSWORD_FILE` и repository file.

Rotation Telegram: создать новые credential-файлы под временными именами, проверить ownership/mode, остановить admin, атомарно заменить `.cred`, запустить сервис и выполнить login/logout/revocation gate. Старый client secret отозвать только после успешной проверки. Rotation restic: сначала создать и проверить новый repository/password и полный backup/restore drill; старый repository сохранять до подтверждённого restore и истечения retention.

## nginx

Установить:

- `deploy/nginx/00-oknotika-zones.conf` → `/etc/nginx/conf.d/00-oknotika-zones.conf`;
- public/admin configs → `/etc/nginx/sites-available/`;
- snippets → `/etc/nginx/snippets/oknotika-*-security-headers.conf`.

Public vhost выдаёт `/articles/` только из `/var/lib/oknotika-admin/article-releases/active/articles/`: HTML/JSON revalidate, hashed media immutable. Admin vhost имеет `client_max_body_size 10m`, отдельные login/general rate limits, `no-store`, CSP, HSTS, nosniff, `frame-ancestors 'none'` и проксирует только в `/run/oknotika-admin/app.sock`.

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

Target обязан быть пустым и изолированным. Скрипт проверяет SQLite integrity, чтение audit state, hashes release manifests, exact active symlink target, `site_state`, completed release и все referenced article/revision rows. Затем отдельно запустить downgrade rehearsal на копии pre-migration DB. Результат, snapshot ID, длительность и удаление временных данных записать в release evidence. Production restore разрешён только в согласованное окно: остановить admin, сохранить повреждённое состояние отдельно, восстановить DB/uploads/article releases, проверить владельцев и hashes, затем запустить reconciliation и smoke tests.

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

Удаление доступа: остановить admin, сделать verified backup, выполнить `npm run disable-editor -- --database /var/lib/oknotika-admin/db/admin.sqlite`, запустить service и убедиться, что старые sessions отозваны и вход запрещён. Для нового subject требуется reviewed maintenance change; автоматической замены editor/RBAC нет.

## Инициализация первой article release

После enrollment и marketing install, но до включения public/admin vhosts, импортировать packaged Al Bahr как первую published revision. Команда копирует reviewed JPEG из public payload в private uploads, идемпотентно создаёт article/revision, валидирует immutable release и переключает `article-releases/active`:

```bash
sudo -u oknotika-admin env PATH=/opt/node-v24.18.0/bin:/usr/bin:/bin \
  /opt/node-v24.18.0/bin/npm --prefix /opt/oknotika-admin/current/admin-app \
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
2. Публичный vhost и `article-releases/active` не переключать: сайт и текущий «Факт недели» продолжают работать статически.
3. Сохранить journal/audit evidence в защищённое хранилище, отозвать Telegram credentials, отключить editor и его sessions.
4. Сделать forensic copy, восстановить доверенный application release и DB/uploads из проверенного snapshot, затем повторить enrollment и все security gates.

## Раздельные rollback procedures

Content rollback: в закрытом редакторе выбрать старую immutable редакцию и вернуть её как новый draft, проверить preview и опубликовать. Для operational rollback всей рубрики выбрать предыдущий completed article release; publisher атомарно переключит `article-releases/active` и запишет audit event. Это не меняет application или marketing release.

Marketing rollback: выбрать предыдущий `/srv/oknotika/releases/<sha>`, проверить его checksum, создать рядом новый относительный symlink и атомарно выполнить `mv -T` в `/srv/oknotika/current`. Не трогать `/articles/`, DB или admin service; затем проверить главную и продуктовые страницы.

Application rollback: остановить admin, сделать verified DB backup, проверить совместимость схемы с предыдущим `/opt/oknotika-admin/releases/<sha>`, атомарно вернуть `/opt/oknotika-admin/current` и запустить service. При breaking migration сначала восстановить соответствующий pre-migration DB backup. Публичный vhost остаётся доступен всё время.

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

Обязательные deferred production gates; не отмечать их выполненными в credential-free package:

- [ ] создать Telegram Web Login application и зарегистрировать exact redirect URI;
- [ ] загрузить OIDC credentials и verified allowlisted subject через systemd credentials/enrollment;
- [ ] выполнить реальный Telegram login/logout/revocation rehearsal;
- [ ] выполнить `nginx -t`, `systemd-analyze verify` и live smoke test на Linux host;
- [ ] настроить реальный encrypted off-host restic repository и выполнить production restore drill;
- [ ] переключать production symlinks только после явного разрешения на deployment.

Live gate после включения TLS/vhosts:

```bash
./deploy/scripts/smoke-test.sh \
  --base-url "$OKNOTIKA_PUBLIC_ORIGIN" \
  --admin-url "$OKNOTIKA_ADMIN_ORIGIN"
```

После первого реального withdrawal повторить smoke с `--withdrawn-path /articles/<slug>/`: gate требует HTTP 410 и generated gone body, а не только текст «410» при HTTP 200.

Если gate не проходит, не продолжать активацию: application symlink вернуть по Application rollback, marketing — только по Marketing rollback, а active article release менять только через Content/operational rollback.
