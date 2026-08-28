#!/bin/sh
set -eu

umask 0027

prepare_private_directory() {
  directory="$1"
  mkdir -p "$directory"
  if [ "$(stat -c %a "$directory")" != 700 ]; then
    chmod 0700 "$directory"
  fi
  if [ ! -w "$directory" ]; then
    echo "container runtime directory is not writable: $directory" >&2
    exit 1
  fi
}

prepare_shared_directory() {
  directory="$1"
  mkdir -p "$directory"
  if [ "$(stat -c %a "$directory")" != 750 ]; then
    chmod 0750 "$directory"
  fi
  if [ ! -w "$directory" ]; then
    echo "container runtime directory is not writable: $directory" >&2
    exit 1
  fi
}

data_root=/var/home/oknotika/admin-app/data
prepare_private_directory "$data_root/db"
prepare_private_directory "$data_root/uploads"
prepare_private_directory "$data_root/previews"
prepare_private_directory "$data_root/backups"
prepare_private_directory "$data_root/backups/online"
prepare_private_directory "$data_root/backups/restic-cache"
prepare_shared_directory "$data_root/article-releases"
prepare_shared_directory "$data_root/article-releases/releases"
prepare_shared_directory "$data_root/article-releases/staging"

exec "$@"
