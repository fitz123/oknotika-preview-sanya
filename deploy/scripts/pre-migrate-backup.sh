#!/usr/bin/env bash
set -euo pipefail

umask 0077
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
state_root="${OKNOTIKA_STATE_ROOT:-/var/lib/oknotika-admin}"
database="${OKNOTIKA_DATABASE_PATH:-$state_root/db/admin.sqlite}"

if [[ ! -s "$database" ]]; then
  exit 0
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
release="${OKNOTIKA_RELEASE_SHA:-unversioned}"
release="${release:0:16}"
destination="$state_root/db/migration-backups/${timestamp}-${release}.sqlite"
node "$script_root/sqlite-online-backup.mjs" "$database" "$destination"
sha256sum "$destination" > "$destination.sha256"
chmod 0600 "$destination" "$destination.sha256"
