#!/usr/bin/env bash
set -euo pipefail

umask 0077
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
state_root="${OKNOTIKA_STATE_ROOT:-/var/lib/oknotika-admin}"
database="${OKNOTIKA_DATABASE_PATH:-$state_root/db/admin.sqlite}"
migrations="$script_root/../../admin-app/migrations"
backup_root="$state_root/db/migration-backups"
maximum_backups=10

prune_migration_backups() {
  local backup_count=0
  while IFS= read -r backup; do
    backup_count=$((backup_count + 1))
    if (( backup_count > maximum_backups )); then
      rm -f -- "$backup" "$backup.sha256"
    fi
  done < <(ls -1t "$backup_root"/*.sqlite 2>/dev/null || true)
}

if [[ ! -s "$database" ]]; then
  exit 0
fi

prune_migration_backups
migration_state="$(node "$script_root/pending-migrations.mjs" "$database" "$migrations")"
[[ -n "$migration_state" ]] || exit 0
IFS=$'\t' read -r current_version target_version migration_fingerprint <<< "$migration_state"
release="${OKNOTIKA_RELEASE_SHA:-unversioned}"
[[ "$release" == "unversioned" || "$release" =~ ^[a-f0-9]{40,64}$ ]] || {
  echo "OKNOTIKA_RELEASE_SHA must be 40-64 lowercase hex characters" >&2
  exit 1
}
release="${release:0:16}"
destination="$backup_root/migration-v${current_version}-to-v${target_version}-${migration_fingerprint}-${release}.sqlite"
if [[ -e "$destination" || -e "$destination.sha256" ]]; then
  [[ -s "$destination" && -s "$destination.sha256" ]] \
    && sha256sum -c "$destination.sha256" >/dev/null || {
      echo "existing pre-migration backup is incomplete or corrupt: $destination" >&2
      exit 1
    }
  exit 0
fi
node "$script_root/sqlite-online-backup.mjs" "$database" "$destination"
sha256sum "$destination" > "$destination.sha256"
chmod 0600 "$destination" "$destination.sha256"
prune_migration_backups
