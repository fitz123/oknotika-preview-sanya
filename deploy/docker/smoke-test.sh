#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/deploy/docker/docker-compose.yml"
compose_env="$repo_root/deploy/docker/compose.env.example"

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is unavailable; isolated container smoke skipped."
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is unavailable; isolated container smoke skipped."
  exit 0
fi
for command in curl python3; do
  command -v "$command" >/dev/null || {
    echo "$command is required for the isolated container smoke" >&2
    exit 1
  }
done

project_name="oknotika-smoke-$$-$(date +%s)"
mkdir -p "$repo_root/var"
temporary_root="$(mktemp -d "$repo_root/var/oknotika-compose-smoke.XXXXXX")"
secrets_root="$temporary_root/secrets"
admin_image="oknotika-admin-smoke:${project_name}"
public_image="oknotika-public-smoke:${project_name}"
mkdir -p "$secrets_root"

read -r admin_port public_port < <(python3 - <<'PY'
import socket

sockets = []
ports = []
for _ in range(2):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    sockets.append(listener)
    ports.append(listener.getsockname()[1])
print(*ports)
for listener in sockets:
    listener.close()
PY
)

printf '%s\n' "smoke-client-$project_name" > "$secrets_root/telegram-oidc-client-id"
printf '%s\n' "smoke-secret-$project_name" > "$secrets_root/telegram-oidc-client-secret"
printf '%s\n' "smoke-weekly-token-$project_name-0123456789" > "$secrets_root/weekly-ingest-token"
chmod 0600 "$secrets_root"/*

export OKNOTIKA_ADMIN_IMAGE="$admin_image"
export OKNOTIKA_PUBLIC_IMAGE="$public_image"
export OKNOTIKA_ADMIN_PORT="$admin_port"
export OKNOTIKA_PUBLIC_PORT="$public_port"
export OKNOTIKA_SECRETS_DIR="$secrets_root"

compose=(docker compose --project-name "$project_name" --file "$compose_file" --env-file "$compose_env")

cleanup() {
  status=$?
  set +e
  if (( status != 0 )); then
    "${compose[@]}" ps
    "${compose[@]}" logs --no-color --tail 100
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1
  docker image rm "$admin_image" "$public_image" >/dev/null 2>&1
  case "$temporary_root" in
    */oknotika-compose-smoke.*) rm -rf -- "$temporary_root" ;;
  esac
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" build
"${compose[@]}" up --detach --wait --wait-timeout 120

"${compose[@]}" exec --no-TTY admin test -r /opt/oknotika/style.css
"${compose[@]}" exec --no-TTY admin test -r /opt/oknotika/img/logo-oknotika.svg
curl --fail --silent --show-error "http://127.0.0.1:$public_port/" >/dev/null
curl --fail --silent --show-error "http://127.0.0.1:$public_port/articles/" >/dev/null
curl --fail --silent --show-error \
  --header 'Host: admin.oknotika.ru' \
  --header 'X-Forwarded-Host: admin.oknotika.ru' \
  --header 'X-Forwarded-Proto: https' \
  --header 'X-Forwarded-For: 127.0.0.1' \
  "http://127.0.0.1:$admin_port/login" >/dev/null

"${compose[@]}" exec --no-TTY admin node -e \
  "const fs=require('node:fs');fs.writeFileSync('/var/lib/oknotika-admin/uploads/.compose-smoke',process.argv[1])" \
  "$project_name"
"${compose[@]}" exec --no-TTY admin node -e \
  "const fs=require('node:fs');if(!fs.statSync('/var/lib/oknotika-admin/db/admin.sqlite').isFile())process.exit(1)"
"${compose[@]}" stop admin
"${compose[@]}" rm --force admin
persisted="$("${compose[@]}" run --rm --no-deps --entrypoint node admin -e \
  "const fs=require('node:fs');if(!fs.statSync('/var/lib/oknotika-admin/db/admin.sqlite').isFile())process.exit(1);process.stdout.write(fs.readFileSync('/var/lib/oknotika-admin/uploads/.compose-smoke','utf8'))")"
[[ "$persisted" == "$project_name" ]] || {
  echo "admin named-volume marker did not survive container recreation" >&2
  exit 1
}

"${compose[@]}" run --rm --no-deps --entrypoint node admin -e \
  "const fs=require('node:fs');const root='/var/lib/oknotika-admin/article-releases';const release=root+'/releases/smoke';fs.mkdirSync(release+'/articles/smoke-persistence',{recursive:true});fs.writeFileSync(release+'/articles/smoke-persistence/index.html','<!doctype html><title>compose persistence</title><p>'+process.argv[1]+'</p>');fs.symlinkSync('releases/smoke',root+'/active')" \
  "$project_name"
curl --fail --silent --show-error "http://127.0.0.1:$public_port/articles/smoke-persistence/" \
  | grep --fixed-strings "$project_name" >/dev/null
"${compose[@]}" stop public
"${compose[@]}" rm --force public
"${compose[@]}" up --detach --wait --wait-timeout 60 public
curl --fail --silent --show-error "http://127.0.0.1:$public_port/articles/smoke-persistence/" \
  | grep --fixed-strings "$project_name" >/dev/null

echo "Docker Compose smoke passed: preview assets, loopback ports and named-volume persistence verified."
