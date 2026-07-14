#!/usr/bin/env bash
set -euo pipefail

expected_node="24.18.0"
expected_sqlite="3.53.1"
expected_socket="/run/oknotika-admin/app.sock"
expected_state_root="/var/lib/oknotika-admin"
expected_app_root="/opt/oknotika-admin/current"
expected_database="$expected_state_root/db/admin.sqlite"
expected_uploads="$expected_state_root/uploads"
expected_previews="$expected_state_root/previews"
expected_article_releases="$expected_state_root/article-releases"
expected_public_root="/srv/oknotika/current"
state_root="${OKNOTIKA_STATE_ROOT:-/var/lib/oknotika-admin}"
app_root="${OKNOTIKA_APP_ROOT:-/opt/oknotika-admin/current}"
service_start=false

if [[ "${1:-}" == "--service-start" ]]; then
  service_start=true
elif [[ $# -ne 0 ]]; then
  echo "usage: preflight.sh [--service-start]" >&2
  exit 2
fi

[[ "$(node --version)" == "v$expected_node" ]] || {
  echo "Node v$expected_node is required" >&2
  exit 1
}
[[ "$(node -p 'process.versions.sqlite')" == "$expected_sqlite" ]] || {
  echo "Bundled SQLite $expected_sqlite is required" >&2
  exit 1
}

for command in restic flock sha256sum; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

[[ -d "$app_root/admin-app" ]] || { echo "admin-app release is missing" >&2; exit 1; }
[[ -f "$app_root/admin-app/package-lock.json" ]] || { echo "package-lock.json is missing" >&2; exit 1; }
[[ -d "$state_root/db" && -d "$state_root/uploads" && -d "$state_root/previews" ]] || {
  echo "private runtime directories are missing" >&2
  exit 1
}

device_root="$(stat -c %d "$state_root/article-releases")"
for path in "$state_root/article-releases/releases" "$state_root/article-releases/staging"; do
  [[ "$(stat -c %d "$path")" == "$device_root" ]] || {
    echo "article staging and releases must share one filesystem" >&2
    exit 1
  }
done

if $service_start; then
  require_exact() {
    local name="$1" actual="$2" expected="$3"
    [[ "$actual" == "$expected" ]] || {
      echo "production $name must use $expected" >&2
      exit 1
    }
  }
  require_exact OKNOTIKA_STATE_ROOT "$state_root" "$expected_state_root"
  require_exact OKNOTIKA_APP_ROOT "$app_root" "$expected_app_root"
  require_exact OKNOTIKA_DATABASE_PATH "${OKNOTIKA_DATABASE_PATH:-}" "$expected_database"
  require_exact OKNOTIKA_UPLOADS_ROOT "${OKNOTIKA_UPLOADS_ROOT:-}" "$expected_uploads"
  require_exact OKNOTIKA_PREVIEWS_ROOT "${OKNOTIKA_PREVIEWS_ROOT:-}" "$expected_previews"
  require_exact OKNOTIKA_ARTICLE_RELEASES_ROOT \
    "${OKNOTIKA_ARTICLE_RELEASES_ROOT:-}" "$expected_article_releases"
  require_exact OKNOTIKA_PUBLIC_ROOT "${OKNOTIKA_PUBLIC_ROOT:-}" "$expected_public_root"
  require_exact OKNOTIKA_LISTEN_SOCKET "${OKNOTIKA_LISTEN_SOCKET:-$expected_socket}" "$expected_socket"
  [[ "${OKNOTIKA_RELEASE_SHA:-}" =~ ^[a-f0-9]{40,64}$ ]] || {
    echo "OKNOTIKA_RELEASE_SHA must be 40-64 lowercase hex characters" >&2
    exit 1
  }
  for name in OKNOTIKA_ADMIN_ORIGIN OKNOTIKA_PUBLIC_ORIGIN TELEGRAM_OIDC_REDIRECT_URI \
    TELEGRAM_OIDC_CLIENT_ID_FILE TELEGRAM_OIDC_CLIENT_SECRET_FILE; do
    [[ -n "${!name:-}" ]] || { echo "$name is required" >&2; exit 1; }
  done
  [[ "$OKNOTIKA_ADMIN_ORIGIN" == "https://admin.oknotika.ru" ]] || {
    echo "admin canonical origin mismatch" >&2
    exit 1
  }
  [[ "$OKNOTIKA_PUBLIC_ORIGIN" == "https://oknotika.ru" ]] || {
    echo "public canonical origin mismatch" >&2
    exit 1
  }
  [[ "$TELEGRAM_OIDC_REDIRECT_URI" == "$OKNOTIKA_ADMIN_ORIGIN/auth/callback" ]] || {
    echo "OIDC redirect URI is not exact" >&2
    exit 1
  }
  [[ -r "$TELEGRAM_OIDC_CLIENT_ID_FILE" && -r "$TELEGRAM_OIDC_CLIENT_SECRET_FILE" ]] || {
    echo "systemd OIDC credentials are not readable" >&2
    exit 1
  }
fi

echo "OKNOTIKA preflight passed (Node $expected_node, SQLite $expected_sqlite)."
