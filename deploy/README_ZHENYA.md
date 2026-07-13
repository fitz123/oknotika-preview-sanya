# Развёртывание ОКНОТИКИ для Жени

Этот пакет разворачивает статический публичный сайт и отдельный закрытый редактор. Публичный nginx не зависит от доступности Node.js: `/articles/` читается из одного immutable release через symlink `active`. В репозитории и release ZIP нет production credentials, Telegram subject, SQLite, uploads, previews или restic password.

## Зафиксированный runtime

- Node.js: ровно `24.18.0` (Krypton LTS), major 24 закреплён в `admin-app/package.json`, exact patch — в `deploy/release-manifest.json`.
- SQLite: встроенный в этот Node.js `node:sqlite`, версия `3.53.1`; отдельного динамического SQLite npm-пакета нет.
- npm-библиотеки: только версии из `admin-app/package-lock.json`; установка исключительно `npm ci`, без обновления lockfile на сервере.
- restic: системный пакет поддерживаемого Linux-дистрибутива. Репозиторий и пароль передаются только systemd credentials.

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

Service имеет empty capabilities, `NoNewPrivileges`, read-only system, private devices/tmp и запись только в `/var/lib/oknotika-admin` и `/run/oknotika-admin`. До старта он создаёт runtime directories, делает verified pre-migration SQLite backup и проверяет exact runtime/origins/credential files.

## Миграции и downgrade

Новые миграции должны быть additive/backward-compatible: новые nullable/default columns, новые таблицы и индексы; запрещены drop/rename/destructive rewrite в обычном релизе. `scripts/check_deploy_package.py` блокирует очевидные destructive SQL statements.

Перед каждым запуском `pre-migrate-backup.sh` создаёт SQLite online snapshot в `db/migration-backups/`, выполняет `PRAGMA integrity_check` и пишет SHA-256. Приложение применяет pending migrations транзакционно только после этого шага.

Breaking migration требует отдельного двухфазного плана и rehearsal:

1. На копии production backup восстановить pre-migration DB.
2. Открыть её предыдущим application release и выполнить его полный test/smoke набор.
3. Применить новый release к другой копии и проверить upgrade.
4. Для downgrade восстановить исходную pre-migration DB; никогда не запускать старый код на необратимо изменённой production DB.
5. Зафиксировать время; весь restore + application activation должен укладываться в RTO: 2 часа.

## Backup и restore

RPO: 24 часа плюс backup после каждого publish. RTO: 2 часа.

`oknotika-admin-backup.timer` запускает daily backup, а `oknotika-admin-backup.path` реагирует на atomic switch `article-releases/active`. `backup.sh` под `flock` создаёт online SQLite snapshot, проверяет его, а затем передаёт restic:

- SQLite с audit events и site/release state;
- private originals и unpublished/published derivatives в `uploads/`;
- immutable article releases, их manifests, required public derivatives и active symlink.

Retention: 7 daily / 8 weekly / 12 monthly. После backup выполняются `restic forget --prune` и `restic check`. Ошибка любого этапа делает systemd unit failed и должна попасть в мониторинг journal.

Restore drill выполнять минимум после первоначальной настройки и после изменений backup topology. Через временный oneshot unit загрузить те же encrypted restic credentials и запустить:

```bash
/opt/oknotika-admin/current/deploy/scripts/restore-drill.sh \
  --target /var/tmp/oknotika-restore-drill-YYYYMMDD
```

Target обязан быть пустым и изолированным. Скрипт проверяет SQLite integrity, чтение audit state и hashes release manifests. Затем отдельно запустить downgrade rehearsal на копии pre-migration DB. Результат, snapshot ID, длительность и удаление временных данных записать в release evidence. Production restore разрешён только в согласованное окно: остановить admin, сохранить повреждённое состояние отдельно, восстановить DB/uploads/article releases, проверить владельцев и hashes, затем запустить reconciliation и smoke tests.

## Первичное подключение редактора

1. Создать отдельное corporate Telegram Web Login приложение с exact production origin/callback.
2. Получить `sub` только из полностью проверенного ID token и сверить с Саней вне Telegram; не использовать username, телефон или непроверенный JWT payload.
3. Пока admin nginx выключен, один раз запустить service для создания DB/migrations, затем остановить его и сделать backup.
4. Локально на VPS выполнить без записи subject в историю:

   `npm run enroll -- --database /var/lib/oknotika-admin/db/admin.sqlite --issuer https://oauth.telegram.org --subject "$VERIFIED_TELEGRAM_SUBJECT"`

5. Сохранить в evidence только timestamp, approvers и fingerprint, не token/subject. Запустить service и выполнить real login/logout/revocation rehearsal до включения admin vhost.

Удаление доступа: остановить admin, сделать verified backup, выполнить `npm run disable-editor -- --database /var/lib/oknotika-admin/db/admin.sqlite`, запустить service и убедиться, что старые sessions отозваны и вход запрещён. Для нового subject требуется reviewed maintenance change; автоматической замены editor/RBAC нет.

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

Если gate не проходит, не продолжать активацию: application symlink вернуть по Application rollback, marketing — только по Marketing rollback, а active article release менять только через Content/operational rollback.
