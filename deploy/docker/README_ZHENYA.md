# Docker Compose: инструкция для Жени

Этот вариант разворачивает весь сайт ОКНОТИКИ двумя контейнерами. `admin`
доступен на хосте только через `127.0.0.1:8000`, `public` — только через
`127.0.0.1:8001`, а внешний host nginx принимает HTTP/HTTPS. Постоянные данные
живут в пяти named volumes проекта `oknotika`, а не в слоях контейнеров.

Production-адреса зафиксированы: `https://oknotika.ru`,
`https://admin.oknotika.ru` и exact Telegram callback
`https://admin.oknotika.ru/auth/callback`.

## Что должно быть готово

- Linux-хост с Docker Engine, Compose v2 (`docker compose`), nginx, `curl`,
  `openssl`, `sha256sum`, `unzip` и достаточным местом для двух копий volumes.
- DNS `A`/`AAAA` для `oknotika.ru`, `www.oknotika.ru` и
  `admin.oknotika.ru` указывает на этот хост. При наличии `AAAA` IPv6 также
  должен доходить до nginx.
- Снаружи открыты только TCP 80/443. Порты 8000/8001 не открывать в firewall.
- До установки production-конфига выпущены и настроены на продление
  сертификаты `/etc/letsencrypt/live/oknotika.ru/{fullchain,privkey}.pem`
  (сертификат покрывает также `www.oknotika.ru`) и
  `/etc/letsencrypt/live/admin.oknotika.ru/{fullchain,privkey}.pem`.
- В отдельном Telegram Web Login приложении зарегистрирован только callback
  `https://admin.oknotika.ru/auth/callback`, алгоритм — RS256. Client ID и
  client secret передаются Жене по закрытому каналу.

Проверить инструменты и не продолжать при ошибке:

```bash
command -v docker nginx curl openssl sha256sum unzip
sudo docker info
sudo docker compose version
sudo nginx -t
```

## Проверка и установка immutable release

Получить ZIP и его SHA-256 по разным согласованным каналам. Недостаточно
посчитать checksum уже после получения: значение нужно сравнить с тем, которое
передал Саша. Для `oknotika-docker-v2.29.0-rc.3.zip`:

```bash
cd /private/incoming
sha256sum --check oknotika-docker-v2.29.0-rc.3.zip.sha256
OKNOTIKA_ARCHIVE_SHA="$(sha256sum oknotika-docker-v2.29.0-rc.3.zip | awk '{print $1}')"
test "${#OKNOTIKA_ARCHIVE_SHA}" -eq 64
OKNOTIKA_RELEASE_DIR="/opt/oknotika-docker/releases/$OKNOTIKA_ARCHIVE_SHA"
sudo test ! -e "$OKNOTIKA_RELEASE_DIR"
sudo install -d -o root -g root -m 0755 "$OKNOTIKA_RELEASE_DIR"
sudo unzip -q oknotika-docker-v2.29.0-rc.3.zip -d "$OKNOTIKA_RELEASE_DIR"
export OKNOTIKA_RELEASE_ROOT="$OKNOTIKA_RELEASE_DIR/oknotika-docker-v2.29.0-rc.3"
sudo test -f "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml"
sudo chown -R root:root "$OKNOTIKA_RELEASE_DIR"
sudo chmod -R a-w "$OKNOTIKA_RELEASE_DIR"
```

Каталог, названный полным checksum, после проверки не изменять. Для каждого
upgrade создаётся новый каталог и новые image tags; старый release и старые
images сохраняются до успешных backup и restore drill.

Создать отдельный non-secret env-файл release. Он содержит только image tags,
loopback-порты и путь к secret-файлам:

```bash
OKNOTIKA_IMAGE_SUFFIX="sha-$(printf '%s' "$OKNOTIKA_ARCHIVE_SHA" | cut -c1-16)"
export OKNOTIKA_COMPOSE_ENV="/etc/oknotika/compose-$OKNOTIKA_ARCHIVE_SHA.env"
sudo install -d -o root -g root -m 0700 /etc/oknotika
printf '%s\n' \
  "OKNOTIKA_ADMIN_IMAGE=oknotika-admin:$OKNOTIKA_IMAGE_SUFFIX" \
  "OKNOTIKA_PUBLIC_IMAGE=oknotika-public:$OKNOTIKA_IMAGE_SUFFIX" \
  'OKNOTIKA_ADMIN_PORT=8000' \
  'OKNOTIKA_PUBLIC_PORT=8001' \
  'OKNOTIKA_SECRETS_DIR=/etc/oknotika/secrets' \
  | sudo tee "$OKNOTIKA_COMPOSE_ENV" >/dev/null
sudo chown root:root "$OKNOTIKA_COMPOSE_ENV"
sudo chmod 0600 "$OKNOTIKA_COMPOSE_ENV"
```

Значение credential запрещено помещать в этот env-файл, Compose
`environment`, Dockerfile, build arg, image, Git, ZIP, shell argv или log.

## Secret-файлы

Compose читает ровно три файла. Ввод OIDC credentials скрыт и не попадает в
shell history; weekly token генерируется на хосте:

```bash
sudo install -d -o root -g root -m 0700 /etc/oknotika/secrets
sudo bash -c '
set -eu
umask 077
for name in telegram-oidc-client-id telegram-oidc-client-secret; do
  read -r -s -p "$name: " value
  printf "\n"
  test -n "$value"
  printf "%s\n" "$value" > "/etc/oknotika/secrets/$name"
  unset value
done
'
sudo install -o root -g root -m 0600 /dev/null \
  /etc/oknotika/secrets/weekly-ingest-token
openssl rand -hex 32 \
  | sudo tee /etc/oknotika/secrets/weekly-ingest-token >/dev/null
sudo chown root:root /etc/oknotika/secrets/*
sudo chmod 0600 /etc/oknotika/secrets/*
sudo test "$(stat -c %a /etc/oknotika/secrets/telegram-oidc-client-id)" = 600
sudo test "$(stat -c %a /etc/oknotika/secrets/telegram-oidc-client-secret)" = 600
sudo test "$(stat -c %a /etc/oknotika/secrets/weekly-ingest-token)" = 600
```

Не выводить содержимое файлов и не сохранять callback URL, authorization code,
Telegram `sub`, weekly payload или response body в журнал/evidence. Example-файлы
из архива заведомо невалидны и не заменяют production credentials.

## Host nginx

Убедиться, что старые vhost с этими `server_name` отключены. Затем установить
copy-ready конфиг, проверить и reload выполнить только после успешного `nginx -t`:

```bash
sudo install -o root -g root -m 0644 \
  "$OKNOTIKA_RELEASE_ROOT/deploy/docker/host-nginx.conf" \
  /etc/nginx/conf.d/oknotika-docker.conf
sudo nginx -t
sudo systemctl reload nginx
```

Конфиг канонизирует HTTP и `www`, проксирует только на
`127.0.0.1:8000`/`127.0.0.1:8001`, ограничивает login/upload/admin requests и
перезаписывает `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` и
`X-Forwarded-For`. Для admin последний заголовок всегда равен `$remote_addr`, а
не цепочке от клиента: приложение принимает только одно проверенное значение.

## Сборка, запуск, health и logs

Во всех штатных командах использовать постоянный project name `oknotika`:

```bash
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" config --quiet
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" build
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait --wait-timeout 120
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" ps
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" logs --no-color --tail 100 admin public
curl --fail --silent --show-error https://oknotika.ru/ >/dev/null
curl --fail --silent --show-error https://oknotika.ru/articles/ >/dev/null
curl --fail --silent --show-error https://admin.oknotika.ru/login >/dev/null
sudo ss -ltnp | grep -E '127\.0\.0\.1:(8000|8001)'
```

Оба container health должны стать `healthy`; в `ss` допустимы только
`127.0.0.1:8000` и `127.0.0.1:8001`, не `0.0.0.0` и не `[::]`. Проверить
редиректы `http://www.oknotika.ru` → `https://oknotika.ru` и
`http://admin.oknotika.ru` → `https://admin.oknotika.ru`.

После успешных проверок атомарно записать активные source/env без изменения
самого release:

```bash
sudo ln -s "$OKNOTIKA_RELEASE_ROOT" "/opt/oknotika-docker/.current-$OKNOTIKA_ARCHIVE_SHA"
sudo mv -Tf "/opt/oknotika-docker/.current-$OKNOTIKA_ARCHIVE_SHA" \
  /opt/oknotika-docker/current
sudo ln -s "$OKNOTIKA_COMPOSE_ENV" "/etc/oknotika/.compose-current-$OKNOTIKA_ARCHIVE_SHA"
sudo mv -Tf "/etc/oknotika/.compose-current-$OKNOTIKA_ARCHIVE_SHA" \
  /etc/oknotika/compose-current.env
```

## Первичное подключение редактора

Остановить обычный admin, чтобы bootstrap был единственным писателем SQLite:

```bash
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" stop admin
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" run --rm --no-deps admin \
  npm run bootstrap-editor
```

Открыть выданный one-time URL в браузере Сани. Redirect может показать 502,
пока обычный admin остановлен; полный callback URL вставить только в
интерактивный prompt. После cryptographic verification сверить identity с Саней
по отдельному каналу и ввести `ENROLL-<fingerprint>`. Сохранить только время,
согласовавших и fingerprint, но не `sub`/code/token. Затем:

```bash
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait admin
```

Саня входит через `https://admin.oknotika.ru`, проверяет logout и повторный
login. Повторный `bootstrap-editor` запрещён; замена identity — отдельная
reviewed maintenance-операция.

## Начальный материал и weekly cover

Перед bootstrap сделать backup по разделу ниже. Packaged JPEG импортирует Al
Bahr идемпотентно как первую published revision и immutable active release:

```bash
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" stop admin
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" run --rm --no-deps \
  --volume "$OKNOTIKA_RELEASE_ROOT/articles/assets/e794ac9b2fc096b47e5a406d.jpg:/run/al-bahr.jpg:ro" \
  admin npm run bootstrap-content -- \
  --database /var/lib/oknotika-admin/db/admin.sqlite \
  --releases-root /var/lib/oknotika-admin/article-releases \
  --uploads-root /var/lib/oknotika-admin/uploads \
  --public-origin https://oknotika.ru \
  --cover /run/al-bahr.jpg
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait admin public
curl --fail --silent --show-error \
  https://oknotika.ru/articles/al-bahr-towers-dynamic-facade/ >/dev/null
```

Повтор команды должен сообщить `already complete`, не создавая вторую статью.

Для утверждённой reusable weekly cover временный private-файл должен быть вне
Git/public root и читаться только root и pinned container group 1000:

```bash
sudo chown root:1000 /private/path/approved-weekly-cover.png
sudo chmod 0640 /private/path/approved-weekly-cover.png
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" stop admin
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" run --rm --no-deps \
  --volume /private/path/approved-weekly-cover.png:/run/weekly-cover.png:ro \
  admin npm run register-weekly-cover -- \
  --database /var/lib/oknotika-admin/db/admin.sqlite \
  --uploads-root /var/lib/oknotika-admin/uploads \
  --public-root /srv/oknotika/public \
  --cover /run/weekly-cover.png
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait admin
```

Передать numeric `assetId` только в private weekly-payload configuration, затем
удалить временный cover. Bearer token не даёт editor session или publish.

Закрытый JSON по `docs/WEEKLY_INGESTION.md` сделать доступным `root:1000 0640` и
запустить draft-only smoke из одноразового контейнера. Token читается только из
Compose secret file, не из argv/env:

```bash
sudo chown root:1000 /private/path/generated-weekly-payload.json
sudo chmod 0640 /private/path/generated-weekly-payload.json
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" run --rm --no-deps \
  --volume "$OKNOTIKA_RELEASE_ROOT/deploy/scripts/smoke-weekly-ingestion.mjs:/run/smoke-weekly-ingestion.mjs:ro" \
  --volume /private/path/generated-weekly-payload.json:/run/weekly-payload.json:ro \
  admin node /run/smoke-weekly-ingestion.mjs \
  --admin-url https://admin.oknotika.ru \
  --payload-file /run/weekly-payload.json \
  --token-file /run/secrets/weekly_ingest_token
```

Ожидается safe `pass`: первый запрос создаёт только draft, identical retry
идемпотентен, bearer получает 401 на editor/rollback API. Саня видит материал
как «Черновик»; public `articles` не меняются до ручного publish.

## Backup named volumes

RPO — не более 24 часов и отдельный backup после каждого publish/перед каждым
upgrade. Для согласованного offline snapshot остановить оба сервиса; команда не
удаляет containers или volumes. Архивировать все пять volumes вместе:

```bash
export OKNOTIKA_BACKUP_DIR="/var/backups/oknotika/YYYYMMDD-HHMMSS"
sudo install -d -o root -g root -m 0700 "$OKNOTIKA_BACKUP_DIR"
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" stop
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" run --rm --no-deps \
  --user 0:0 --cap-add DAC_READ_SEARCH --entrypoint sh \
  --volume "$OKNOTIKA_BACKUP_DIR:/backup" admin -c '
set -eu
tar --numeric-owner -C /var/lib/oknotika-admin/db -cpf /backup/admin_database.tar .
tar --numeric-owner -C /var/lib/oknotika-admin/uploads -cpf /backup/admin_uploads.tar .
tar --numeric-owner -C /var/lib/oknotika-admin/previews -cpf /backup/admin_previews.tar .
tar --numeric-owner -C /var/lib/oknotika-admin/backups -cpf /backup/admin_backups.tar .
tar --numeric-owner -C /var/lib/oknotika-admin/article-releases -cpf /backup/article_releases.tar .
'
sudo sh -c 'cd "$1"; sha256sum *.tar > SHA256SUMS' _ "$OKNOTIKA_BACKUP_DIR"
printf '%s\n' "$OKNOTIKA_ARCHIVE_SHA" \
  | sudo tee "$OKNOTIKA_BACKUP_DIR/SOURCE_ARCHIVE_SHA256" >/dev/null
sudo cp "$OKNOTIKA_COMPOSE_ENV" "$OKNOTIKA_BACKUP_DIR/compose.env"
sudo chown -R root:root "$OKNOTIKA_BACKUP_DIR"
sudo chmod 0700 "$OKNOTIKA_BACKUP_DIR"
sudo chmod 0600 "$OKNOTIKA_BACKUP_DIR"/*
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait
```

Скопировать backup в encrypted off-host storage, проверить `sha256sum -c
SHA256SUMS` там и записать дату, source checksum и длительность без private
данных. Локальная копия на том же диске не считается backup.

## Restore без перезаписи текущих volumes

Restore всегда делать в новый Compose project: исходные `oknotika_*` volumes
остаются нетронутыми. Проверить checksum и source release, задать новое уникальное
имя из lowercase ASCII, затем создать пустые volumes:

```bash
export OKNOTIKA_RESTORE_PROJECT=oknotika-restore-yyyymmddhhmm
cd "$OKNOTIKA_BACKUP_DIR"
sudo sha256sum --check SHA256SUMS
sudo docker compose --project-name "$OKNOTIKA_RESTORE_PROJECT" \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" create
sudo docker compose --project-name "$OKNOTIKA_RESTORE_PROJECT" \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" run --rm --no-deps \
  --user 0:0 --cap-add DAC_READ_SEARCH --cap-add DAC_OVERRIDE \
  --cap-add CHOWN --cap-add FOWNER --entrypoint sh \
  --volume "$OKNOTIKA_BACKUP_DIR:/backup:ro" admin -c '
set -eu
for directory in db uploads previews backups article-releases; do
  test -z "$(find "/var/lib/oknotika-admin/$directory" -mindepth 1 -print -quit)"
done
tar --numeric-owner -C /var/lib/oknotika-admin/db -xpf /backup/admin_database.tar
tar --numeric-owner -C /var/lib/oknotika-admin/uploads -xpf /backup/admin_uploads.tar
tar --numeric-owner -C /var/lib/oknotika-admin/previews -xpf /backup/admin_previews.tar
tar --numeric-owner -C /var/lib/oknotika-admin/backups -xpf /backup/admin_backups.tar
tar --numeric-owner -C /var/lib/oknotika-admin/article-releases -xpf /backup/article_releases.tar
'
```

Только после успешной распаковки остановить активный project (без удаления) и
запустить восстановленный, который займёт те же loopback ports:

```bash
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" stop
sudo docker compose --project-name "$OKNOTIKA_RESTORE_PROJECT" \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait --wait-timeout 120
curl --fail --silent --show-error https://oknotika.ru/ >/dev/null
curl --fail --silent --show-error https://oknotika.ru/articles/ >/dev/null
curl --fail --silent --show-error https://admin.oknotika.ru/login >/dev/null
```

Проверить login, SQLite state, uploads и active article release. При любой ошибке
остановить restore project командой `docker compose ... stop` и снова запустить
project `oknotika`; исходные volumes всё ещё на месте. После успешного restore
зафиксировать новое active project name для всех следующих операций. Никогда не
восстанавливать только SQLite отдельно от согласованного набора volumes.

## Upgrade и rollback без потери данных

До upgrade сделать полный backup выше. Новый ZIP проверить, распаковать в новый
checksum-каталог, создать новый release env и собрать новые checksum-tagged
images, не перезаписывая старые tags. С тем же active project name выполнить
`up --detach --no-build --wait`; Compose заменит containers, но подключит те же
named volumes. Проверить health, login, public site и weekly draft smoke. Только
после pass переключить `current`/`compose-current.env`.

Если новый application release не проходит gate, взять прежние
`OKNOTIKA_RELEASE_ROOT` и `OKNOTIKA_COMPOSE_ENV` из сохранённых symlinks и
выполнить:

```bash
sudo docker compose --project-name oknotika \
  --file "$OLD_OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OLD_OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait --wait-timeout 120
```

Это application rollback: он не удаляет и не заменяет DB/uploads/releases. Если
данные новой версии несовместимы со старой, не экспериментировать на текущих
volumes — восстановить согласованный pre-upgrade backup в новый project по
процедуре Restore. Старые project volumes, source checksum, env и image tags
сохранять до подтверждённого restore drill.

## Emergency stop и абсолютные запреты

Для немедленного отключения write surface, сохранив публичный статический сайт:

```bash
sudo docker compose --project-name oknotika \
  --file "$OKNOTIKA_RELEASE_ROOT/deploy/docker/docker-compose.yml" \
  --env-file "$OKNOTIKA_COMPOSE_ENV" stop admin
```

Для остановки всего стека без удаления данных использовать `stop` без имени
service. После расследования тот же exact release запускается через `up
--detach --no-build --wait`.

- `docker compose down -v` ЗАПРЕЩЕНА: флаг `-v` удаляет persistent volumes.
- Запрещено менять binding на `0.0.0.0:8000`, `0.0.0.0:8001`, `[::]:8000` или
  `[::]:8001`; backend-порты остаются только на loopback за host nginx.
- Запрещено встраивать credentials в Compose/environment, image/build args,
  source/archive, команды, logs или evidence.
- Не удалять старые volumes/images/releases до проверенного off-host backup,
  isolated restore и окончания rollback window.
