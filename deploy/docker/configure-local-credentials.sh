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

mode=""
rollback_snapshot=""
if [[ $# -eq 0 ]]; then
  mode="configure"
elif [[ $# -eq 2 && "$1" == "--rollback" \
    && "$2" =~ ^(local-credential|rollback-safety)-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]]; then
  mode="rollback"
  rollback_snapshot="$2"
else
  echo "Usage: configure-local-credentials.sh [--rollback SNAPSHOT_NAME]" >&2
  exit 2
fi

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

admin_was_running=0
admin_stop_attempted=0
admin_container="$("${compose[@]}" ps -q admin)"
if [[ -n "$admin_container" \
    && "$(docker inspect --format '{{.State.Running}}' "$admin_container")" == "true" ]]; then
  admin_was_running=1
fi

restore_admin_after_failure() {
  status=$?
  trap - EXIT
  unset local_username local_password local_password_confirmation
  if [[ $status -ne 0 && $admin_was_running -eq 1 && $admin_stop_attempted -eq 1 ]]; then
    echo "Credential maintenance failed; restoring the previously running admin container." >&2
    if ! "${compose[@]}" start admin >/dev/null; then
      echo "Could not restart admin automatically; run: docker compose ... start admin" >&2
    fi
  fi
  exit "$status"
}
trap restore_admin_after_failure EXIT

if [[ "$mode" == "configure" ]]; then
  IFS= read -r -p "Локальный логин: " local_username </dev/tty
  IFS= read -r -s -p "Пароль (минимум 14 символов): " local_password </dev/tty
  printf '\n' >/dev/tty
  IFS= read -r -s -p "Повторите пароль: " local_password_confirmation </dev/tty
  printf '\n' >/dev/tty
  [[ "$local_username" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]{2,63}$ ]] || {
    echo "Логин должен содержать 3–64 символа ASCII: буквы, цифры, точку, _, @ или -." >&2
    exit 2
  }
  [[ ${#local_password} -ge 14 ]] || {
    echo "Пароль должен содержать минимум 14 символов." >&2
    exit 2
  }
  [[ "$local_password" == "$local_password_confirmation" ]] || {
    echo "Пароли не совпадают." >&2
    exit 2
  }
  admin_stop_attempted=1
  "${compose[@]}" stop admin >/dev/null
  printf '%s\n%s\n%s\n' "$local_username" "$local_password" "$local_password_confirmation" \
    | "${container_command[@]}"
  unset local_username local_password local_password_confirmation
else
  admin_stop_attempted=1
  "${compose[@]}" stop admin >/dev/null
  "${container_command[@]}" --rollback "$rollback_snapshot"
fi

current="$credentials_root/current"
if [[ -L "$current" ]]; then
  [[ "$(stat -Lc %u:%g "$current/username")" == "0:1000" ]]
  [[ "$(stat -Lc %a "$current/username")" == "640" ]]
  [[ "$(stat -Lc %u:%g "$current/password-hash")" == "0:1000" ]]
  [[ "$(stat -Lc %a "$current/password-hash")" == "640" ]]
fi

echo "Credential maintenance completed; admin remains stopped until login verification."
