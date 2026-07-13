#!/usr/bin/env bash
set -euo pipefail

umask 0077
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
state_root="${OKNOTIKA_STATE_ROOT:-/var/lib/oknotika-admin}"
database="${OKNOTIKA_DATABASE_PATH:-$state_root/db/admin.sqlite}"
snapshot="$state_root/backups/online/admin.sqlite"
lock="$state_root/backups/backup.lock"

: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE must be a systemd credential path}"
: "${RESTIC_REPOSITORY_FILE:?RESTIC_REPOSITORY_FILE must be a systemd credential path}"
[[ -r "$RESTIC_PASSWORD_FILE" && -r "$RESTIC_REPOSITORY_FILE" ]] || {
  echo "restic credentials are not readable" >&2
  exit 1
}
[[ -s "$database" ]] || { echo "database does not exist: $database" >&2; exit 1; }

exec 9>"$lock"
flock -n 9 || { echo "another backup is running" >&2; exit 0; }

node "$script_root/sqlite-online-backup.mjs" "$database" "$snapshot"

paths=(backups/online/admin.sqlite uploads article-releases/releases)
[[ -L "$state_root/article-releases/active" ]] && paths+=(article-releases/active)

cd "$state_root"
restic --repository-file "$RESTIC_REPOSITORY_FILE" backup \
  --tag oknotika-admin \
  --tag "release-${OKNOTIKA_RELEASE_SHA:-unknown}" \
  "${paths[@]}"
restic --repository-file "$RESTIC_REPOSITORY_FILE" forget \
  --tag oknotika-admin \
  --keep-daily 7 \
  --keep-weekly 8 \
  --keep-monthly 12 \
  --prune
restic --repository-file "$RESTIC_REPOSITORY_FILE" check
