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

Для weekly cover private-файл должен иметь root:1000 0640. Команда
register-weekly-cover использует database, uploads и public-root по новым путям.
Private weekly JSON также имеет root:1000 0640; draft-only smoke запускается с
deploy/scripts/smoke-weekly-ingestion.mjs и читает token только из
/run/secrets/weekly_ingest_token.

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

Не распаковывать backup поверх live data. Сначала проверить, что tar читается,
затем распаковать его в новый root-owned staging-каталог и проверить наличие
всех каталогов и права.
Для drill использовать отдельную копию source tree и OKNOTIKA_HOST_ROOT,
указывающий на task-owned restore root; production default не менять.

После успешного isolated drill production restore делается только в maintenance
window: остановить оба сервиса, переименовать текущий data в
data.before-restore, атомарно переместить проверенный data на его место и
запустить containers с --force-recreate. При любой ошибке остановить stack,
вернуть data.before-restore и повторно запустить прежние images. Никогда не
восстанавливать только SQLite отдельно от uploads и article-releases.

## Upgrade и rollback

До upgrade сделать полный backup и сохранить source-копию admin-app без data,
public-app и deploy. Новый versioned ZIP распаковывается в root-owned staging
вне /var/home/oknotika. Проверить, что staging содержит ровно admin-app,
public-app и deploy и не содержит admin-app/data.

Собрать новые уникальные image tags из staging, используя его
deploy/docker/docker-compose.yml, но production
OKNOTIKA_HOST_ROOT=/var/home/oknotika. Только после health gates остановить
stack, заменить три source-каталога, вернуть неизменённый
admin-app/data на место и запустить новые images. Проверить public, articles,
admin login/logout и weekly draft smoke.

Rollback заменяет только три source-каталога и image tags на сохранённые.
admin-app/data не удалять, не переносить в public-app и не заменять без полной
restore-процедуры. Старые images/source и encrypted off-host backup сохранять
до успешного restore drill и окончания rollback window.

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
