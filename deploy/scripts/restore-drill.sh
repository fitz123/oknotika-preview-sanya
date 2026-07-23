#!/usr/bin/env bash
set -euo pipefail

umask 0077
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target=""
snapshot="latest"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) target="${2:-}"; shift 2 ;;
    --snapshot) snapshot="${2:-}"; shift 2 ;;
    *) echo "usage: restore-drill.sh --target EMPTY_DIRECTORY [--snapshot ID]" >&2; exit 2 ;;
  esac
done

: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE must be set}"
: "${RESTIC_REPOSITORY_FILE:?RESTIC_REPOSITORY_FILE must be set}"
[[ -n "$target" ]] || { echo "--target is required" >&2; exit 2; }
target="$(realpath -m "$target")"
case "$target" in
  /|/var|/var/lib|/srv|/opt|\
  /var/lib/oknotika-admin|/var/lib/oknotika-admin/*|\
  /srv/oknotika|/srv/oknotika/*|\
  /opt/oknotika-admin|/opt/oknotika-admin/*)
    echo "refusing to restore into a production path" >&2
    exit 1
    ;;
esac
[[ ! -e "$target" || -z "$(find "$target" -mindepth 1 -print -quit 2>/dev/null)" ]] || {
  echo "restore target must be empty" >&2
  exit 1
}
install -d -m 0700 "$target"
restic --repository-file "$RESTIC_REPOSITORY_FILE" restore "$snapshot" \
  --tag oknotika-admin \
  --target "$target"
node "$script_root/verify-restored-state.mjs" "$target"
echo "Restore drill passed in $target. Do not copy it over production without an approved restore window."
