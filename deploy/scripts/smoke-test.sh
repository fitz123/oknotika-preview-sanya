#!/usr/bin/env bash
set -euo pipefail

base_url=""
admin_url=""
withdrawn_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) base_url="${2%/}"; shift 2 ;;
    --admin-url) admin_url="${2%/}"; shift 2 ;;
    --withdrawn-path) withdrawn_path="${2:-}"; shift 2 ;;
    *) echo "usage: smoke-test.sh --base-url HTTPS_ORIGIN --admin-url HTTPS_ORIGIN [--withdrawn-path /articles/slug/]" >&2; exit 2 ;;
  esac
done

[[ "$base_url" =~ ^https://[^/]+$ ]] || { echo "--base-url must be an HTTPS origin" >&2; exit 2; }
[[ "$admin_url" =~ ^https://[^/]+$ ]] || { echo "--admin-url must be an HTTPS origin" >&2; exit 2; }
[[ -z "$withdrawn_path" || "$withdrawn_path" =~ ^/articles/[a-z0-9]+(-[a-z0-9]+)*/$ ]] || {
  echo "--withdrawn-path must be an article detail path" >&2
  exit 2
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
  local name="$1" url="$2"
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    --dump-header "$work/$name.headers" \
    --output "$work/$name.body" \
    "$url"
}

assert_header() {
  local file="$1" expression="$2" message="$3"
  tr -d '\r' < "$file" | rg --ignore-case --quiet "$expression" || {
    echo "$message" >&2
    exit 1
  }
}

fetch public "$base_url/"
fetch articles "$base_url/articles/"
fetch latest "$base_url/articles/latest.json"
fetch admin "$admin_url/login"

assert_header "$work/public.headers" '^strict-transport-security:' 'public HSTS header is missing'
assert_header "$work/articles.headers" '^cache-control: public, max-age=0, must-revalidate$' 'article cache policy is wrong'
assert_header "$work/admin.headers" '^cache-control: no-store$' 'admin no-store header is missing'
assert_header "$work/admin.headers" '^content-security-policy:.*frame-ancestors .none.' 'admin CSP is missing frame-ancestors none'
assert_header "$work/admin.headers" '^x-content-type-options: nosniff$' 'admin nosniff header is missing'
rg --quiet 'Факт недели' "$work/articles.body" || { echo "article listing content is missing" >&2; exit 1; }
node -e 'const fs=require("node:fs"); JSON.parse(fs.readFileSync(process.argv[1], "utf8"))' "$work/latest.body"

if [[ -n "$withdrawn_path" ]]; then
  withdrawn_status="$(curl --silent --show-error --output "$work/withdrawn.body" --write-out '%{http_code}' \
    --proto '=https' --tlsv1.2 "$base_url$withdrawn_path")"
  [[ "$withdrawn_status" == 410 ]] || { echo "withdrawn article returned HTTP $withdrawn_status instead of 410" >&2; exit 1; }
  rg --quiet '410 · Факт недели' "$work/withdrawn.body" || { echo "withdrawn article body is missing" >&2; exit 1; }
fi

echo "Public and admin smoke tests passed."
