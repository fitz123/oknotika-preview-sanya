#!/usr/bin/env bash
set -euo pipefail

umask 0022
source_root=""
release_sha=""
marketing_root="${OKNOTIKA_MARKETING_ROOT:-/srv/oknotika}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) source_root="${2:-}"; shift 2 ;;
    --release-sha) release_sha="${2:-}"; shift 2 ;;
    --marketing-root) marketing_root="${2:-}"; shift 2 ;;
    *) echo "usage: install-marketing.sh --source RELEASE_PAYLOAD --release-sha SHA [--marketing-root DIRECTORY]" >&2; exit 2 ;;
  esac
done

[[ -d "$source_root" ]] || { echo "release payload does not exist: $source_root" >&2; exit 1; }
[[ "$release_sha" =~ ^[a-f0-9]{40,64}$ ]] || { echo "release SHA must be 40-64 lowercase hex characters" >&2; exit 2; }
[[ ! -L "$source_root" ]] || { echo "release payload root must not be a symlink" >&2; exit 1; }
[[ -z "$(find "$source_root" -type l -print -quit)" ]] || { echo "release payload contains a symlink" >&2; exit 1; }

public_paths=(
  index.html script.js style.css js img articles aluminum carbon-glass glass
  oknotika-smart-window protectapeel pvc wood-stoller
)
for path in index.html script.js style.css js img articles; do
  [[ -e "$source_root/$path" ]] || { echo "required public path is missing: $path" >&2; exit 1; }
done

install -d -o root -g root -m 0755 "$marketing_root/releases"
target="$marketing_root/releases/$release_sha"
[[ ! -e "$target" ]] || { echo "immutable marketing release already exists: $target" >&2; exit 1; }
stage="$marketing_root/releases/.${release_sha}.stage.$$"
trap 'rm -rf -- "$stage" "$marketing_root/.current.new.$$"' EXIT
install -d -o root -g root -m 0755 "$stage"
for path in "${public_paths[@]}"; do
  [[ -e "$source_root/$path" ]] || continue
  cp -a -- "$source_root/$path" "$stage/$path"
done
chown -R root:root "$stage"
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod 0644 {} +
mv -- "$stage" "$target"
ln -s "releases/$release_sha" "$marketing_root/.current.new.$$"
mv -Tf -- "$marketing_root/.current.new.$$" "$marketing_root/current"
trap - EXIT
echo "Activated marketing release $release_sha at $marketing_root/current"
