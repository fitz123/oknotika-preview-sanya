# Docker Compose: инструкция для Жени

ZIP распаковывается прямо в /var/home/oknotika. В корне должны быть только
admin-app/, public-app/ и deploy/. Контейнер admin доступен на хосте только
через 127.0.0.1:8000, public — только через 127.0.0.1:8001, а внешний nginx
принимает HTTP/HTTPS.

Исходники редактора находятся в /var/home/oknotika/admin-app, статический сайт —
в /var/home/oknotika/public-app. Все постоянные закрытые данные admin находятся
в /var/home/oknotika/admin-app/data/. Каталог
/var/home/oknotika/public-app/data/ зарезервирован, но не используется и не
подключается к контейнеру public.

Production-адреса зафиксированы: https://oknotika.ru,
https://admin.oknotika.ru и exact Telegram callback
https://admin.oknotika.ru/auth/callback.

## Что должно быть готово

- Linux-хост с Docker Engine, Compose v2, nginx, bash, curl, openssl, tar и
  unzip.
- DNS A/AAAA для oknotika.ru, www.oknotika.ru и admin.oknotika.ru указывает на
  этот хост.
- Снаружи открыты только TCP 80/443. Порты 8000/8001 не открывать в firewall.
- Сертификаты
  /etc/letsencrypt/live/oknotika.ru/{fullchain,privkey}.pem и
  /etc/letsencrypt/live/admin.oknotika.ru/{fullchain,privkey}.pem уже выпущены
  и настроены на продление.
- В Telegram Web Login зарегистрирован только callback
  https://admin.oknotika.ru/auth/callback с алгоритмом RS256.

Проверка инструментов:

~~~bash
set -euo pipefail
command -v docker nginx bash curl openssl tar unzip
sudo docker info
sudo docker compose version
sudo nginx -t
~~~

## Установка архива

Получить один файл oknotika-docker-v2.29.0-rc.4.zip. Дополнительный файл
проверочной суммы для этого handoff не нужен. ZIP распаковывается без
оборачивающего каталога прямо в новый /var/home/oknotika.

~~~bash
set -euo pipefail
cd /private/incoming
export OKNOTIKA_ROOT=/var/home/oknotika
sudo test ! -e "$OKNOTIKA_ROOT"
sudo install -d -o root -g root -m 0755 "$OKNOTIKA_ROOT"
sudo unzip -q oknotika-docker-v2.29.0-rc.4.zip -d "$OKNOTIKA_ROOT"
sudo test -d "$OKNOTIKA_ROOT/admin-app"
sudo test -d "$OKNOTIKA_ROOT/public-app"
sudo test -d "$OKNOTIKA_ROOT/deploy"
test "$(sudo find "$OKNOTIKA_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | tr '\n' ' ')" = "admin-app deploy public-app "
sudo test -f "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml"
~~~

Не создавать четвёртый каталог рядом с этими тремя и не переносить deploy/ в
root. Для upgrade сначала выполнить backup и процедуру из соответствующего
раздела, а не распаковывать новый ZIP поверх работающих файлов.

## Каталоги данных и права

Compose использует bind mounts с create_host_path=false. Поэтому каталоги нужно
создать заранее с правильным владельцем; Docker не должен молча создавать их от
root. Приватные каталоги имеют mode 0700, article-releases — 0750 для
read-only-доступа public по группе 1000.

~~~bash
set -euo pipefail
export OKNOTIKA_ROOT=/var/home/oknotika
sudo install -d -o 1000 -g 1000 -m 0700 "$OKNOTIKA_ROOT/admin-app/data/db" "$OKNOTIKA_ROOT/admin-app/data/uploads" "$OKNOTIKA_ROOT/admin-app/data/previews" "$OKNOTIKA_ROOT/admin-app/data/backups" "$OKNOTIKA_ROOT/admin-app/data/private"
sudo install -d -o 1000 -g 1000 -m 0750 "$OKNOTIKA_ROOT/admin-app/data/article-releases"
sudo install -d -o root -g 1000 -m 0750 "$OKNOTIKA_ROOT/admin-app/data/secrets"
sudo install -d -o 1000 -g 1000 -m 0750 "$OKNOTIKA_ROOT/public-app/data"
~~~

public-app/data остаётся пустым и не перечислен в volumes. В public доступен
только admin-app/data/article-releases, причём read-only. DB, uploads, previews,
backups, private и secrets контейнеру public недоступны.

## Secret-файлы и non-secret Compose env

Compose читает ровно три файла из admin-app/data/secrets. Ввод OIDC credentials
скрыт и не попадает в shell history; weekly token генерируется на хосте.

~~~bash
set -euo pipefail
export OKNOTIKA_ROOT=/var/home/oknotika
export OKNOTIKA_SECRETS_ROOT="$OKNOTIKA_ROOT/admin-app/data/secrets"
sudo bash -c '
set -eu
umask 077
secrets_root="$1"
for name in telegram-oidc-client-id telegram-oidc-client-secret; do
  read -r -s -p "$name: " value
  printf "\n"
  test -n "$value"
  printf "%s\n" "$value" > "$secrets_root/$name"
  unset value
done
' _ "$OKNOTIKA_SECRETS_ROOT"
sudo install -o root -g 1000 -m 0640 /dev/null "$OKNOTIKA_SECRETS_ROOT/weekly-ingest-token"
openssl rand -hex 32 | sudo tee "$OKNOTIKA_SECRETS_ROOT/weekly-ingest-token" >/dev/null
sudo chown root:1000 "$OKNOTIKA_SECRETS_ROOT"/*
sudo chmod 0640 "$OKNOTIKA_SECRETS_ROOT"/*
for name in telegram-oidc-client-id telegram-oidc-client-secret weekly-ingest-token; do
  test "$(sudo stat -c %u:%g "$OKNOTIKA_SECRETS_ROOT/$name")" = 0:1000
  test "$(sudo stat -c %a "$OKNOTIKA_SECRETS_ROOT/$name")" = 640
done
~~~

Не выводить содержимое файлов и не сохранять callback URL, authorization code,
Telegram sub, weekly payload или response body в журнал. Example-файлы из ZIP
заведомо невалидны и не заменяют production credentials.

Создать private non-secret env с versioned image tags. Для следующего handoff
значение OKNOTIKA_RELEASE меняется на его новую версию. Credential в этот файл,
Compose environment, Dockerfile, build arg, image, Git, ZIP, shell argv или log
помещать запрещено.

~~~bash
set -euo pipefail
export OKNOTIKA_ROOT=/var/home/oknotika
export OKNOTIKA_RELEASE=v2.29.0-rc.4
export OKNOTIKA_COMPOSE_ENV="$OKNOTIKA_ROOT/admin-app/data/private/compose.env"
printf '%s\n' "OKNOTIKA_ADMIN_IMAGE=oknotika-admin:$OKNOTIKA_RELEASE" "OKNOTIKA_PUBLIC_IMAGE=oknotika-public:$OKNOTIKA_RELEASE" 'OKNOTIKA_ADMIN_PORT=8000' 'OKNOTIKA_PUBLIC_PORT=8001' | sudo tee "$OKNOTIKA_COMPOSE_ENV" >/dev/null
sudo chown root:1000 "$OKNOTIKA_COMPOSE_ENV"
sudo chmod 0640 "$OKNOTIKA_COMPOSE_ENV"
~~~

## Host nginx

Отключить старые vhost с теми же server_name. Установить copy-ready конфиг и
делать reload только после успешного nginx -t.

~~~bash
set -euo pipefail
export OKNOTIKA_ROOT=/var/home/oknotika
sudo install -o root -g root -m 0644 "$OKNOTIKA_ROOT/deploy/docker/host-nginx.conf" /etc/nginx/conf.d/oknotika-docker.conf
sudo nginx -t
sudo systemctl reload nginx
~~~

Конфиг канонизирует HTTP и www, проксирует только на
127.0.0.1:8000/127.0.0.1:8001 и заменяет Host, X-Forwarded-Host,
X-Forwarded-Proto и X-Forwarded-For. Для admin X-Forwarded-For всегда равен
$remote_addr, а не цепочке клиента.

## Сборка, запуск, health и logs

В новой shell-сессии всегда задать эти три переменные:

~~~bash
set -euo pipefail
export OKNOTIKA_ROOT=/var/home/oknotika
export OKNOTIKA_ACTIVE_PROJECT=oknotika
export OKNOTIKA_COMPOSE_ENV="$OKNOTIKA_ROOT/admin-app/data/private/compose.env"
sudo test -f "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml"
sudo test -f "$OKNOTIKA_COMPOSE_ENV"
~~~

Собрать и запустить:

~~~bash
set -euo pipefail
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" config --quiet
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" build
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait --wait-timeout 120
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" ps
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" logs --no-color --tail 100 admin public
curl --fail --silent --show-error https://oknotika.ru/ >/dev/null
curl --fail --silent --show-error https://oknotika.ru/articles/ >/dev/null
curl --fail --silent --show-error https://admin.oknotika.ru/login >/dev/null
sudo ss -ltnp | grep -E '127\.0\.0\.1:(8000|8001)'
~~~

Оба container health должны стать healthy. В ss допустимы только
127.0.0.1:8000 и 127.0.0.1:8001, не 0.0.0.0 и не [::].

## Первичное подключение редактора

Остановить обычный admin, чтобы bootstrap был единственным писателем SQLite:

~~~bash
set -euo pipefail
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" stop admin
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" run --rm --no-deps admin npm run bootstrap-editor
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait admin
~~~

Открыть one-time URL в браузере Сани. После cryptographic verification сверить
identity с Саней по отдельному каналу и ввести ENROLL-<fingerprint>. Не
сохранять sub/code/token. Повторный bootstrap-editor запрещён.

## Начальный материал и weekly cover

Перед bootstrap сделать backup. Packaged JPEG импортируется идемпотентно:

~~~bash
set -euo pipefail
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" stop admin
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" run --rm --no-deps --volume "$OKNOTIKA_ROOT/public-app/articles/assets/e794ac9b2fc096b47e5a406d.jpg:/run/al-bahr.jpg:ro" admin npm run bootstrap-content -- --database /var/home/oknotika/admin-app/data/db/admin.sqlite --releases-root /var/home/oknotika/admin-app/data/article-releases --uploads-root /var/home/oknotika/admin-app/data/uploads --public-origin https://oknotika.ru --cover /run/al-bahr.jpg
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait admin public
~~~

Для утверждённого reusable weekly cover private-файл должен находиться вне Git и
public root. Команда печатает только non-secret metadata; сохранить `assetId` в
private weekly-payload configuration и не копировать cover в source tree.

~~~bash
set -euo pipefail
export OKNOTIKA_WEEKLY_COVER=/private/path/approved-weekly-cover.png
sudo test -f "$OKNOTIKA_WEEKLY_COVER"
test "$(sudo stat -c %u:%g "$OKNOTIKA_WEEKLY_COVER")" = 0:1000
test "$(sudo stat -c %a "$OKNOTIKA_WEEKLY_COVER")" = 640
restart_admin_after_cover() {
  cover_status=$?
  trap - EXIT
  set +e
  sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait admin
  restart_status=$?
  if (( cover_status != 0 )); then exit "$cover_status"; fi
  exit "$restart_status"
}
trap restart_admin_after_cover EXIT
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" stop admin
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" run --rm --no-deps --volume "$OKNOTIKA_WEEKLY_COVER:/run/weekly-cover.png:ro" admin npm run register-weekly-cover -- --database /var/home/oknotika/admin-app/data/db/admin.sqlite --uploads-root /var/home/oknotika/admin-app/data/uploads --public-root /var/home/oknotika/public-app --cover /run/weekly-cover.png
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait admin
trap - EXIT
~~~

Закрытый weekly JSON из `deploy/docs/WEEKLY_INGESTION.md` также должен иметь
root:1000 0640. Draft-only smoke читает token только из Compose secret file, не
из argv/env; первый запрос создаёт только draft, retry должен быть идемпотентным,
а bearer должен получить 401 на editor/rollback API.

~~~bash
set -euo pipefail
export OKNOTIKA_WEEKLY_PAYLOAD=/private/path/generated-weekly-payload.json
sudo test -f "$OKNOTIKA_WEEKLY_PAYLOAD"
test "$(sudo stat -c %u:%g "$OKNOTIKA_WEEKLY_PAYLOAD")" = 0:1000
test "$(sudo stat -c %a "$OKNOTIKA_WEEKLY_PAYLOAD")" = 640
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" run --rm --no-deps --volume "$OKNOTIKA_ROOT/deploy/scripts/smoke-weekly-ingestion.mjs:/run/smoke-weekly-ingestion.mjs:ro" --volume "$OKNOTIKA_WEEKLY_PAYLOAD:/run/weekly-payload.json:ro" admin node /run/smoke-weekly-ingestion.mjs --admin-url https://admin.oknotika.ru --payload-file /run/weekly-payload.json --token-file /run/secrets/weekly_ingest_token
~~~

Ожидается `status: pass`; Саня видит материал как «Черновик», а public articles
не меняются до ручного publish.

## Backup bind-mounted data

RPO — не более 24 часов и отдельный backup после каждого publish/перед upgrade.
Остановить admin, public может продолжать read-only обслуживание. Архивировать
весь data единым согласованным набором, включая private env и secrets; backup
должен храниться только в encrypted off-host storage.

~~~bash
set -euo pipefail
export OKNOTIKA_BACKUP_DIR=/var/backups/oknotika/YYYYMMDD-HHMMSS
sudo test ! -e "$OKNOTIKA_BACKUP_DIR"
sudo install -d -o root -g root -m 0700 "$OKNOTIKA_BACKUP_DIR"
restart_after_backup() {
  backup_status=$?
  trap - EXIT
  set +e
  sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait admin
  restart_status=$?
  if (( backup_status != 0 )); then exit "$backup_status"; fi
  exit "$restart_status"
}
trap restart_after_backup EXIT
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" stop admin
sudo tar --numeric-owner -C "$OKNOTIKA_ROOT/admin-app" -cpf "$OKNOTIKA_BACKUP_DIR/admin-data.tar" data
sudo tar -tf "$OKNOTIKA_BACKUP_DIR/admin-data.tar" >/dev/null
sudo chmod 0600 "$OKNOTIKA_BACKUP_DIR/admin-data.tar"
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait admin
trap - EXIT
~~~

## Isolated restore drill

Не распаковывать backup поверх live data. Следующий блок восстанавливает его в
отдельный root, запускает отдельный Compose project на 18000/18001 и не касается
production data или портов. Значения root/project заменить на уникальные; каталог
не должен существовать заранее.

~~~bash
set -euo pipefail
export OKNOTIKA_BACKUP_DIR=/var/backups/oknotika/YYYYMMDD-HHMMSS
export OKNOTIKA_RESTORE_ROOT=/var/home/oknotika-restore-YYYYMMDD-HHMMSS
export OKNOTIKA_RESTORE_PROJECT=oknotika-restore-yyyymmddhhmmss
export OKNOTIKA_RESTORE_ENV="$OKNOTIKA_RESTORE_ROOT/compose.env"
[[ "$OKNOTIKA_BACKUP_DIR" =~ ^/var/backups/oknotika/[0-9A-Za-z._-]+$ ]]
[[ "$OKNOTIKA_RESTORE_ROOT" =~ ^/var/home/oknotika-restore-[0-9A-Za-z._-]+$ ]]
[[ "$OKNOTIKA_RESTORE_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]]
sudo test -f "$OKNOTIKA_BACKUP_DIR/admin-data.tar"
sudo test ! -e "$OKNOTIKA_RESTORE_ROOT"
sudo tar -tf "$OKNOTIKA_BACKUP_DIR/admin-data.tar" >/dev/null
sudo install -d -o root -g root -m 0755 "$OKNOTIKA_RESTORE_ROOT/admin-app" "$OKNOTIKA_RESTORE_ROOT/public-app"
sudo install -d -o 1000 -g 1000 -m 0750 "$OKNOTIKA_RESTORE_ROOT/public-app/data"
sudo tar --numeric-owner -C "$OKNOTIKA_RESTORE_ROOT/admin-app" -xpf "$OKNOTIKA_BACKUP_DIR/admin-data.tar"
for directory in db uploads previews backups article-releases private secrets; do
  sudo test -d "$OKNOTIKA_RESTORE_ROOT/admin-app/data/$directory"
done
sudo sh -c 'grep -E "^OKNOTIKA_(ADMIN|PUBLIC)_IMAGE=[A-Za-z0-9][A-Za-z0-9._:/-]*$" "$1" > "$2"' _ "$OKNOTIKA_COMPOSE_ENV" "$OKNOTIKA_RESTORE_ENV"
test "$(sudo grep -Ec '^OKNOTIKA_(ADMIN|PUBLIC)_IMAGE=' "$OKNOTIKA_RESTORE_ENV")" -eq 2
printf '%s\n' "OKNOTIKA_HOST_ROOT=$OKNOTIKA_RESTORE_ROOT" 'OKNOTIKA_ADMIN_PORT=18000' 'OKNOTIKA_PUBLIC_PORT=18001' | sudo tee -a "$OKNOTIKA_RESTORE_ENV" >/dev/null
sudo chown root:root "$OKNOTIKA_RESTORE_ENV"
sudo chmod 0600 "$OKNOTIKA_RESTORE_ENV"
sudo docker compose --project-name "$OKNOTIKA_RESTORE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_RESTORE_ENV" config --quiet
sudo docker compose --project-name "$OKNOTIKA_RESTORE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_RESTORE_ENV" up --detach --no-build --wait --wait-timeout 120
curl --fail --silent --show-error http://127.0.0.1:18001/healthz >/dev/null
curl --fail --silent --show-error -H 'Host: admin.oknotika.ru' -H 'X-Forwarded-Host: admin.oknotika.ru' -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-For: 127.0.0.1' http://127.0.0.1:18000/login >/dev/null
sudo docker compose --project-name "$OKNOTIKA_RESTORE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_RESTORE_ENV" stop
~~~

Проверить SQLite state, uploads и active article release в restore root. После
этого production restore делать только в maintenance window. Блок ниже
автоматически возвращает `data.before-restore` и прежние images при любом
неуспешном gate; failed candidate сохраняется в restore root для расследования.

~~~bash
set -euo pipefail
export OKNOTIKA_RESTORE_ROOT=/var/home/oknotika-restore-YYYYMMDD-HHMMSS
export OKNOTIKA_FAILED_DATA="$OKNOTIKA_RESTORE_ROOT/admin-app/data.failed-production-restore"
export OKNOTIKA_ACTIVE_RESTORE_ENV="$OKNOTIKA_RESTORE_ROOT/active-production-compose.env"
sudo test -d "$OKNOTIKA_RESTORE_ROOT/admin-app/data"
sudo test ! -e "$OKNOTIKA_ROOT/admin-app/data.before-restore"
sudo test ! -e "$OKNOTIKA_FAILED_DATA"
sudo test ! -e "$OKNOTIKA_ACTIVE_RESTORE_ENV"
sudo install -o root -g root -m 0600 "$OKNOTIKA_COMPOSE_ENV" "$OKNOTIKA_ACTIVE_RESTORE_ENV"
rollback_failed_restore() {
  restore_status=$?
  trap - EXIT
  set +e
  sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" stop
  if sudo test -d "$OKNOTIKA_ROOT/admin-app/data.before-restore"; then
    if sudo test -e "$OKNOTIKA_ROOT/admin-app/data"; then
      sudo mv "$OKNOTIKA_ROOT/admin-app/data" "$OKNOTIKA_FAILED_DATA"
    fi
    sudo mv "$OKNOTIKA_ROOT/admin-app/data.before-restore" "$OKNOTIKA_ROOT/admin-app/data"
  fi
  sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait --wait-timeout 120
  restart_status=$?
  if (( restart_status != 0 )); then echo 'Не удалось автоматически вернуть прежний stack.' >&2; fi
  exit "$restore_status"
}
trap rollback_failed_restore EXIT
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" stop
sudo mv "$OKNOTIKA_ROOT/admin-app/data" "$OKNOTIKA_ROOT/admin-app/data.before-restore"
sudo mv "$OKNOTIKA_RESTORE_ROOT/admin-app/data" "$OKNOTIKA_ROOT/admin-app/data"
sudo install -o root -g 1000 -m 0640 "$OKNOTIKA_ACTIVE_RESTORE_ENV" "$OKNOTIKA_COMPOSE_ENV.next"
sudo mv "$OKNOTIKA_COMPOSE_ENV.next" "$OKNOTIKA_COMPOSE_ENV"
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --force-recreate --wait --wait-timeout 120
curl --fail --silent --show-error https://oknotika.ru/ >/dev/null
curl --fail --silent --show-error https://oknotika.ru/articles/ >/dev/null
curl --fail --silent --show-error https://admin.oknotika.ru/login >/dev/null
read -r -p 'После проверки login, SQLite, uploads и active release введите RESTORE-PASS: ' OKNOTIKA_RESTORE_CONFIRMATION
test "$OKNOTIKA_RESTORE_CONFIRMATION" = RESTORE-PASS
unset OKNOTIKA_RESTORE_CONFIRMATION
trap - EXIT
sudo mv "$OKNOTIKA_ROOT/admin-app/data.before-restore" "$OKNOTIKA_RESTORE_ROOT/admin-app/data.before-restore"
~~~

Никогда не восстанавливать только SQLite отдельно от uploads и
article-releases. Restore root и прежний data сохранять до окончания rollback
window и копирования проверенного backup в encrypted off-host storage.

## Upgrade и rollback

До upgrade выполнить backup и isolated restore drill выше. Следующая процедура
сначала распаковывает новый ZIP в root-owned staging и строит versioned images,
не трогая active stack. Source swap выполняется с явным downtime. При ошибке
после stop trap возвращает старые три source-каталога, неизменённый data и старые
image tags. Production Compose сохраняет default
`OKNOTIKA_HOST_ROOT=/var/home/oknotika`; override используется только в isolated
restore.

~~~bash
set -euo pipefail
export OKNOTIKA_NEW_ARCHIVE=/private/incoming/oknotika-docker-vX.Y.Z.zip
export OKNOTIKA_NEW_RELEASE=vX.Y.Z
export OKNOTIKA_STAGE_ROOT="/var/home/oknotika-stage-$OKNOTIKA_NEW_RELEASE"
export OKNOTIKA_PREVIOUS_ROOT="/var/home/oknotika-before-$OKNOTIKA_NEW_RELEASE"
export OKNOTIKA_NEW_COMPOSE_ENV="$OKNOTIKA_ROOT/admin-app/data/private/compose-$OKNOTIKA_NEW_RELEASE.env"
export OKNOTIKA_OLD_COMPOSE_ENV="$OKNOTIKA_PREVIOUS_ROOT/compose.env"
export OKNOTIKA_BUILD_PROJECT=oknotika-upgrade-build
export OKNOTIKA_WEEKLY_PAYLOAD=/private/path/generated-weekly-payload.json
[[ "$OKNOTIKA_NEW_RELEASE" =~ ^v[0-9][0-9A-Za-z._-]*$ ]]
[[ "$OKNOTIKA_STAGE_ROOT" =~ ^/var/home/oknotika-stage-v[0-9A-Za-z._-]+$ ]]
[[ "$OKNOTIKA_PREVIOUS_ROOT" =~ ^/var/home/oknotika-before-v[0-9A-Za-z._-]+$ ]]
sudo test -f "$OKNOTIKA_NEW_ARCHIVE"
sudo test -f "$OKNOTIKA_WEEKLY_PAYLOAD"
sudo test ! -e "$OKNOTIKA_STAGE_ROOT"
sudo test ! -e "$OKNOTIKA_PREVIOUS_ROOT"
sudo test ! -e "$OKNOTIKA_NEW_COMPOSE_ENV"
cleanup_failed_upgrade_prepare() {
  prepare_status=$?
  trap - EXIT
  set +e
  sudo rm -f -- "$OKNOTIKA_NEW_COMPOSE_ENV"
  sudo rm -rf --one-file-system -- "$OKNOTIKA_STAGE_ROOT" "$OKNOTIKA_PREVIOUS_ROOT"
  exit "$prepare_status"
}
trap cleanup_failed_upgrade_prepare EXIT
sudo install -d -o root -g root -m 0755 "$OKNOTIKA_STAGE_ROOT" "$OKNOTIKA_PREVIOUS_ROOT"
sudo install -o root -g root -m 0600 "$OKNOTIKA_COMPOSE_ENV" "$OKNOTIKA_OLD_COMPOSE_ENV"
sudo unzip -q "$OKNOTIKA_NEW_ARCHIVE" -d "$OKNOTIKA_STAGE_ROOT"
test "$(sudo find "$OKNOTIKA_STAGE_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | tr '\n' ' ')" = 'admin-app deploy public-app '
sudo test ! -e "$OKNOTIKA_STAGE_ROOT/admin-app/data"
sudo test -f "$OKNOTIKA_STAGE_ROOT/deploy/docker/docker-compose.yml"
sudo install -o root -g 1000 -m 0640 /dev/null "$OKNOTIKA_NEW_COMPOSE_ENV"
printf '%s\n' "OKNOTIKA_ADMIN_IMAGE=oknotika-admin:$OKNOTIKA_NEW_RELEASE" "OKNOTIKA_PUBLIC_IMAGE=oknotika-public:$OKNOTIKA_NEW_RELEASE" 'OKNOTIKA_ADMIN_PORT=8000' 'OKNOTIKA_PUBLIC_PORT=8001' | sudo tee "$OKNOTIKA_NEW_COMPOSE_ENV" >/dev/null
sudo docker compose --project-name "$OKNOTIKA_BUILD_PROJECT" --file "$OKNOTIKA_STAGE_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_NEW_COMPOSE_ENV" config --quiet
sudo docker compose --project-name "$OKNOTIKA_BUILD_PROJECT" --file "$OKNOTIKA_STAGE_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_NEW_COMPOSE_ENV" build
rollback_failed_upgrade() {
  upgrade_status=$?
  trap - EXIT
  set +e
  if sudo test -f "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml"; then
    sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_NEW_COMPOSE_ENV" stop
  fi
  if sudo test -d "$OKNOTIKA_ROOT/admin-app/data" && sudo test -d "$OKNOTIKA_PREVIOUS_ROOT/admin-app" && ! sudo test -e "$OKNOTIKA_PREVIOUS_ROOT/admin-app/data"; then
    sudo mv "$OKNOTIKA_ROOT/admin-app/data" "$OKNOTIKA_PREVIOUS_ROOT/admin-app/data"
  fi
  for name in admin-app public-app deploy; do
    if sudo test -d "$OKNOTIKA_ROOT/$name" && ! sudo test -e "$OKNOTIKA_STAGE_ROOT/$name"; then sudo mv "$OKNOTIKA_ROOT/$name" "$OKNOTIKA_STAGE_ROOT/$name"; fi
    if sudo test -d "$OKNOTIKA_PREVIOUS_ROOT/$name" && ! sudo test -e "$OKNOTIKA_ROOT/$name"; then sudo mv "$OKNOTIKA_PREVIOUS_ROOT/$name" "$OKNOTIKA_ROOT/$name"; fi
  done
  sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_OLD_COMPOSE_ENV" up --detach --no-build --wait --wait-timeout 120
  restart_status=$?
  if (( restart_status != 0 )); then echo 'Не удалось автоматически вернуть прежний stack.' >&2; fi
  exit "$upgrade_status"
}
trap rollback_failed_upgrade EXIT
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_OLD_COMPOSE_ENV" stop
for name in admin-app public-app deploy; do sudo mv "$OKNOTIKA_ROOT/$name" "$OKNOTIKA_PREVIOUS_ROOT/$name"; done
for name in admin-app public-app deploy; do sudo mv "$OKNOTIKA_STAGE_ROOT/$name" "$OKNOTIKA_ROOT/$name"; done
sudo mv "$OKNOTIKA_PREVIOUS_ROOT/admin-app/data" "$OKNOTIKA_ROOT/admin-app/data"
sudo install -d -o 1000 -g 1000 -m 0750 "$OKNOTIKA_ROOT/public-app/data"
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_NEW_COMPOSE_ENV" up --detach --no-build --wait --wait-timeout 120
curl --fail --silent --show-error https://oknotika.ru/ >/dev/null
curl --fail --silent --show-error https://oknotika.ru/articles/ >/dev/null
curl --fail --silent --show-error https://admin.oknotika.ru/login >/dev/null
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_NEW_COMPOSE_ENV" run --rm --no-deps --volume "$OKNOTIKA_ROOT/deploy/scripts/smoke-weekly-ingestion.mjs:/run/smoke-weekly-ingestion.mjs:ro" --volume "$OKNOTIKA_WEEKLY_PAYLOAD:/run/weekly-payload.json:ro" admin node /run/smoke-weekly-ingestion.mjs --admin-url https://admin.oknotika.ru --payload-file /run/weekly-payload.json --token-file /run/secrets/weekly_ingest_token
read -r -p 'После проверки login/logout введите UPGRADE-PASS: ' OKNOTIKA_UPGRADE_CONFIRMATION
test "$OKNOTIKA_UPGRADE_CONFIRMATION" = UPGRADE-PASS
unset OKNOTIKA_UPGRADE_CONFIRMATION
sudo install -o root -g 1000 -m 0640 "$OKNOTIKA_NEW_COMPOSE_ENV" "$OKNOTIKA_COMPOSE_ENV.next"
sudo mv "$OKNOTIKA_COMPOSE_ENV.next" "$OKNOTIKA_COMPOSE_ENV"
trap - EXIT
~~~

Если regression обнаружен после успешного promotion, следующий блок возвращает
прежние source и image tags; текущий data переносится вместе и не заменяется.

~~~bash
set -euo pipefail
export OKNOTIKA_NEW_RELEASE=vX.Y.Z
export OKNOTIKA_PREVIOUS_ROOT="/var/home/oknotika-before-$OKNOTIKA_NEW_RELEASE"
export OKNOTIKA_FAILED_ROOT="/var/home/oknotika-failed-$OKNOTIKA_NEW_RELEASE"
export OKNOTIKA_OLD_COMPOSE_ENV="$OKNOTIKA_PREVIOUS_ROOT/compose.env"
sudo test -d "$OKNOTIKA_PREVIOUS_ROOT/admin-app"
sudo test -f "$OKNOTIKA_OLD_COMPOSE_ENV"
sudo test ! -e "$OKNOTIKA_FAILED_ROOT"
sudo install -d -o root -g root -m 0755 "$OKNOTIKA_FAILED_ROOT"
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" stop
sudo mv "$OKNOTIKA_ROOT/admin-app/data" "$OKNOTIKA_PREVIOUS_ROOT/admin-app/data"
for name in admin-app public-app deploy; do sudo mv "$OKNOTIKA_ROOT/$name" "$OKNOTIKA_FAILED_ROOT/$name"; done
for name in admin-app public-app deploy; do sudo mv "$OKNOTIKA_PREVIOUS_ROOT/$name" "$OKNOTIKA_ROOT/$name"; done
sudo install -o root -g 1000 -m 0640 "$OKNOTIKA_OLD_COMPOSE_ENV" "$OKNOTIKA_COMPOSE_ENV.next"
sudo mv "$OKNOTIKA_COMPOSE_ENV.next" "$OKNOTIKA_COMPOSE_ENV"
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" up --detach --no-build --wait --wait-timeout 120
curl --fail --silent --show-error https://oknotika.ru/ >/dev/null
curl --fail --silent --show-error https://oknotika.ru/articles/ >/dev/null
curl --fail --silent --show-error https://admin.oknotika.ru/login >/dev/null
~~~

Старые/new images, source roots, failed candidate и encrypted off-host backup
сохранять до успешного restore drill и окончания rollback window.

## Emergency stop и абсолютные запреты

Для немедленного отключения write surface, сохранив публичный сайт:

~~~bash
set -euo pipefail
sudo docker compose --project-name "$OKNOTIKA_ACTIVE_PROJECT" --file "$OKNOTIKA_ROOT/deploy/docker/docker-compose.yml" --env-file "$OKNOTIKA_COMPOSE_ENV" stop admin
~~~

- docker compose down -v ЗАПРЕЩЕНА.
- Запрещено менять binding на 0.0.0.0:8000, 0.0.0.0:8001, [::]:8000 или
  [::]:8001.
- Запрещено встраивать credentials в Compose/environment, image/build args,
  source/archive, команды, logs или evidence.
- Запрещено монтировать DB, uploads, previews, backups, private или secrets в
  public. Единственный runtime mount public — article-releases read-only.
