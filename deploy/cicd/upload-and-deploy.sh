#!/usr/bin/env bash
set -Eeuo pipefail

umask 0077

usage() {
  echo "usage: upload-and-deploy.sh --bundle SHA.zip --checksum-file SHA.zip.sha256 --release-sha SHA --host HOST --port PORT --user USER --identity-file PATH --known-hosts PATH --remote-incoming PATH" >&2
  exit 2
}

fail() {
  echo "upload and deploy failed: $*" >&2
  exit 1
}

bundle=""
checksum_file=""
release_sha=""
host=""
port=""
user=""
identity_file=""
known_hosts=""
remote_incoming=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle) bundle="${2:-}"; shift 2 ;;
    --checksum-file) checksum_file="${2:-}"; shift 2 ;;
    --release-sha) release_sha="${2:-}"; shift 2 ;;
    --host) host="${2:-}"; shift 2 ;;
    --port) port="${2:-}"; shift 2 ;;
    --user) user="${2:-}"; shift 2 ;;
    --identity-file) identity_file="${2:-}"; shift 2 ;;
    --known-hosts) known_hosts="${2:-}"; shift 2 ;;
    --remote-incoming) remote_incoming="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

for value in "$bundle" "$checksum_file" "$release_sha" "$host" "$port" "$user" "$identity_file" "$known_hosts" "$remote_incoming"; do
  [[ -n "$value" ]] || usage
done

[[ "$release_sha" =~ ^[a-f0-9]{40}([a-f0-9]{24})?$ ]] || fail "release SHA must be 40 or 64 lowercase hex characters"
[[ "$host" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$host" != *..* ]] || fail "host must be a DNS name or IPv4 address without shell metacharacters"
[[ "$user" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail "user is invalid"
[[ "$port" =~ ^[0-9]{1,5}$ ]] || fail "port must be numeric"
(( 10#$port >= 1 && 10#$port <= 65535 )) || fail "port must be between 1 and 65535"
[[ "$remote_incoming" == "/var/lib/oknotika-deploy/incoming" ]] || fail "remote incoming directory must use the reviewed fixed path"

for pair in "bundle:$bundle" "checksum file:$checksum_file" "identity file:$identity_file" "known-hosts file:$known_hosts"; do
  label="${pair%%:*}"
  path="${pair#*:}"
  [[ "$path" == /* && -f "$path" && ! -L "$path" ]] || fail "$label must be an absolute regular non-symlink file"
done
[[ "$(basename -- "$bundle")" == "$release_sha.zip" ]] || fail "bundle basename must match the release SHA"
[[ "$(basename -- "$checksum_file")" == "$release_sha.zip.sha256" ]] || fail "checksum basename must match the release SHA"

checksum_line="$(< "$checksum_file")"
[[ "$checksum_line" =~ ^([a-f0-9]{64})\ \ ($release_sha\.zip)$ ]] || fail "checksum file must contain one lowercase SHA-256 entry for the bundle basename"
expected_checksum="${BASH_REMATCH[1]}"
read -r actual_checksum _ < <(sha256sum -- "$bundle")
[[ "$actual_checksum" == "$expected_checksum" ]] || fail "bundle SHA-256 does not match the checksum file"

lookup_host="$host"
if [[ "$port" != "22" ]]; then
  lookup_host="[$host]:$port"
fi
ssh-keygen -F "$lookup_host" -f "$known_hosts" >/dev/null \
  || fail "known-hosts file has no pinned key for the selected host and port"

ssh_options=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$known_hosts"
  -o IdentitiesOnly=yes
  -o "IdentityFile=$identity_file"
  -o "Port=$port"
)
target="$user@$host"
remote_bundle="$remote_incoming/$release_sha.zip"
remote_checksum="$remote_incoming/$release_sha.zip.sha256"

scp "${ssh_options[@]}" -- "$bundle" "$checksum_file" "$target:$remote_incoming/"
ssh "${ssh_options[@]}" -- "$target" \
  sudo -n /usr/local/sbin/oknotika-deploy \
    --bundle "$remote_bundle" \
    --checksum-file "$remote_checksum" \
    --release-sha "$release_sha"
