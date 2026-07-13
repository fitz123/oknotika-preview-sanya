#!/usr/bin/env bash
set -euo pipefail

umask 0027
state_root="${OKNOTIKA_STATE_ROOT:-/var/lib/oknotika-admin}"
runtime_root="${OKNOTIKA_RUNTIME_ROOT:-/run/oknotika-admin}"

install -d -m 0700 \
  "$state_root/db" \
  "$state_root/db/migration-backups" \
  "$state_root/uploads" \
  "$state_root/previews" \
  "$state_root/backups" \
  "$state_root/backups/online" \
  "$state_root/backups/restic-cache"
install -d -m 0750 \
  "$state_root/article-releases" \
  "$state_root/article-releases/releases" \
  "$state_root/article-releases/staging" \
  "$runtime_root"

chmod 0700 "$state_root/db" "$state_root/uploads" "$state_root/previews" "$state_root/backups"
chmod 0750 "$state_root/article-releases" "$state_root/article-releases/releases" "$state_root/article-releases/staging"
