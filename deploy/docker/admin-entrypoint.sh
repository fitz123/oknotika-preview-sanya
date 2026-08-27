#!/bin/sh
set -eu

umask 0027

prepare_private_directory() {
  directory="$1"
  mkdir -p "$directory"
  chmod 0700 "$directory"
  if [ ! -w "$directory" ]; then
    echo "container runtime directory is not writable: $directory" >&2
    exit 1
  fi
}

prepare_shared_directory() {
  directory="$1"
  mkdir -p "$directory"
  chmod 0750 "$directory"
  if [ ! -w "$directory" ]; then
    echo "container runtime directory is not writable: $directory" >&2
    exit 1
  fi
}

prepare_private_directory /var/lib/oknotika-admin/db
prepare_private_directory /var/lib/oknotika-admin/uploads
prepare_private_directory /var/lib/oknotika-admin/previews
prepare_private_directory /var/lib/oknotika-admin/backups
prepare_private_directory /var/lib/oknotika-admin/backups/online
prepare_private_directory /var/lib/oknotika-admin/backups/restic-cache
prepare_shared_directory /var/lib/oknotika-admin/article-releases
prepare_shared_directory /var/lib/oknotika-admin/article-releases/releases
prepare_shared_directory /var/lib/oknotika-admin/article-releases/staging

exec "$@"
