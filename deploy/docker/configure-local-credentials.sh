#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "configure-local-credentials.sh must run as root" >&2
  exit 1
fi

oknotika_root="${OKNOTIKA_ROOT:-/var/home/oknotika}"
compose_project="${OKNOTIKA_ACTIVE_PROJECT:-oknotika}"
compose_file="$oknotika_root/deploy/docker/docker-compose.yml"
compose_env="${OKNOTIKA_COMPOSE_ENV:-$oknotika_root/admin-app/data/private/compose.env}"
database_root="$oknotika_root/admin-app/data/db"
credentials_root="$oknotika_root/admin-app/data/secrets/local-credentials"
backups_root="$oknotika_root/admin-app/data/backups/local-credentials"
compose=(docker compose --project-name "$compose_project" --file "$compose_file" --env-file "$compose_env")

[[ -f "$compose_file" && -f "$compose_env" ]] || {
  echo "Compose file or private Compose environment is missing" >&2
  exit 1
}
command -v docker >/dev/null
command -v python3 >/dev/null
command -v flock >/dev/null
docker info >/dev/null

install -d -o 0 -g 1000 -m 0750 "$credentials_root"
install -d -o 0 -g 0 -m 0700 "$backups_root"
exec 9>"$backups_root/.maintenance.lock"
chmod 0600 "$backups_root/.maintenance.lock"
flock -n 9 || { echo "Another local credential maintenance run is active" >&2; exit 1; }

admin_image="$("${compose[@]}" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["admin"]["image"])')"
[[ -n "$admin_image" ]] || { echo "Admin image could not be resolved" >&2; exit 1; }
docker image inspect "$admin_image" >/dev/null || {
  echo "Build the configured admin image before credential maintenance" >&2
  exit 1
}
"${compose[@]}" stop admin >/dev/null

container_command=(
  docker run --rm -i
  --user 0:0
  --read-only
  --network none
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777
  --cap-drop ALL
  --cap-add CHOWN
  --cap-add DAC_OVERRIDE
  --cap-add FOWNER
  --security-opt no-new-privileges:true
  --volume "$database_root:/runtime/db"
  --volume "$credentials_root:/runtime/credentials"
  --volume "$backups_root:/runtime/backups"
  --entrypoint node
  "$admin_image"
  scripts/configure-local-credentials.js
  --database /runtime/db/admin.sqlite
  --credentials-root /runtime/credentials
  --backups-root /runtime/backups
)

if [[ "${1:-}" == "--rollback" ]]; then
  [[ $# -eq 2 && "$2" =~ ^(local-credential|rollback-safety)-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || {
    echo "Usage: configure-local-credentials.sh --rollback SNAPSHOT_NAME" >&2
    exit 2
  }
  "${container_command[@]}" --rollback "$2"
elif [[ $# -eq 0 ]]; then
  IFS= read -r -p "Локальный логин: " local_username </dev/tty
  IFS= read -r -s -p "Пароль (минимум 14 символов): " local_password </dev/tty
  printf '\n' >/dev/tty
  IFS= read -r -s -p "Повторите пароль: " local_password_confirmation </dev/tty
  printf '\n' >/dev/tty
  printf '%s\n%s\n%s\n' "$local_username" "$local_password" "$local_password_confirmation" \
    | "${container_command[@]}"
  unset local_username local_password local_password_confirmation
else
  echo "Usage: configure-local-credentials.sh [--rollback SNAPSHOT_NAME]" >&2
  exit 2
fi

current="$credentials_root/current"
if [[ -L "$current" ]]; then
  [[ "$(stat -Lc %u:%g "$current/username")" == "0:1000" ]]
  [[ "$(stat -Lc %a "$current/username")" == "640" ]]
  [[ "$(stat -Lc %u:%g "$current/password-hash")" == "0:1000" ]]
  [[ "$(stat -Lc %a "$current/password-hash")" == "640" ]]
fi

echo "Credential maintenance completed; admin remains stopped until login verification."
