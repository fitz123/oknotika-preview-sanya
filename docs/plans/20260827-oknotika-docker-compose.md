# Plan: Docker Compose deployment for OKNOTIKA

## Goal

Deliver a reviewed, secret-free Docker Compose deployment package for the complete OKNOTIKA public site and Telegram-authenticated news editor. The host exposes only loopback ports `127.0.0.1:8000` for the admin service and `127.0.0.1:8001` for the public service; an external host nginx terminates TLS and proxies exact production domains `admin.oknotika.ru` and `oknotika.ru` to those ports.

## Approved outcome and constraints

- Sanya forwarded Zhenya’s direct request to convert the current package to Docker Compose.
- Required host ports are exact: admin `8000`, public `8001`.
- The corrected admin domain is `admin.oknotika.ru`; `admin.okntoika.ru` was explicitly rejected as a typo. Public domain is `oknotika.ru`.
- The package must include both files and a Russian instruction for Zhenya.
- Current source baseline is `feature/oknotika-cicd-20260810` at `1306d9e04019716027d61b6c716eabd8bd5dc3c0`; this Docker work is a dedicated stacked branch.
- Existing application invariants remain authoritative: Node `24.18.0`, bundled SQLite `3.53.1`, immutable article releases, Telegram OIDC exact callback, private DB/uploads/previews, draft-only weekly ingestion, and no credentials/runtime state in Git or release archives.

## Architecture choice

Add Docker Compose as a supported alternative deployment path without deleting the existing systemd path. Use two application containers:

1. `admin`: Node application listening on container TCP `0.0.0.0:8000`, published only as `127.0.0.1:8000:8000`; persistent volumes for DB, uploads, previews, backups and article releases; Compose secrets mounted as files.
2. `public`: internal nginx serving the bundled static site plus the shared article-release volume read-only, listening on container port `8001`, published only as `127.0.0.1:8001:8001`.

A host nginx configuration owns public TLS, canonical redirects, request limits/rate limits/security headers, and `proxy_pass` to loopback ports. The admin application keeps exact trusted proxy-header validation. Compose healthchecks and restart policies are operational liveness mechanisms; persistent data is never stored in container layers.

## Non-goals

- No live server login, Docker installation on Zhenya’s host, DNS/TLS mutation, certificate issuance, secret generation, Telegram application creation, editor enrollment or production deployment in this implementation run.
- No credentials, Telegram subject, SQLite, uploads, previews, weekly payloads, backups or private keys in source, image layers, build args, Compose environment values, logs or archives.
- No exposure of ports `8000`/`8001` on public interfaces; both stay bound to loopback behind host nginx.
- No typo domain `admin.okntoika.ru` and no alternate callback.
- No third TLS/proxy container: Zhenya explicitly requested a host nginx `proxy_pass` configuration.
- No removal of the existing systemd/nginx deployment path; Docker Compose is an additional supported path and gets its own runbook.
- No automatic destructive migration, data reset or content rollback. Existing additive migration and immutable content rules remain.
- No unrelated changes to public design, editorial behavior, Telegram authorization policy or CI/CD architecture.
- No merge, release activation or production deploy. A Docker-specific secret-free archive is the user-facing deliverable.
- No ADR write without Sanya’s separate approval after showing the proposed record.

## Validation Commands

```bash
cd admin-app
npm ci
npm run lint
npm test
npm run test:security
npm run build
npm run render:fixture

cd ..
python3 -m unittest discover -s tests -v
python3 scripts/check_generated_articles.py var/test-release
python3 scripts/check_deploy_package.py .
python3 scripts/check_final_documentation.py .
python3 scripts/check_docker_package.py .

docker compose -f deploy/docker/docker-compose.yml --env-file deploy/docker/compose.env.example config
python3 scripts/build_docker_package.py --repo . --commit HEAD --output release/oknotika-docker-v2.29.0-rc.3.zip
python3 scripts/check_docker_archive.py release/oknotika-docker-v2.29.0-rc.3.zip
```

When the local Docker daemon is available, also build both images and run the repository’s isolated Compose smoke test with task-owned temporary secrets/volumes and guaranteed cleanup.

## Tasks

### Task 1: Add a safe TCP listener mode for the admin service

**Goal:** Let the existing admin application run behind a container TCP proxy without weakening the current Unix-socket production mode.

**Serves:** Zhenya’s requirement that the admin service run on port `8000` under Docker Compose.

- [x] Extend configuration with mutually exclusive, validated Unix-socket and TCP host/port modes; Docker defaults remain explicit rather than silently changing systemd behavior.
- [x] Refactor startup/shutdown so socket cleanup/chmod occurs only for Unix sockets and TCP binds the configured host/port.
- [x] Add focused configuration/listener tests for valid container mode, invalid ports/hosts, mixed modes and unchanged Unix-socket behavior.
- [x] Preserve exact origin, callback, proxy-header and runtime-separation checks.

### Task 2: Add container images and Compose topology

**Goal:** Build the complete admin/public stack with loopback-only host bindings, persistent state and file-mounted secrets.

**Serves:** Zhenya’s requirements for `docker-compose`, admin `8000`, public `8001`, and a deployable complete site.

- [x] Add minimal pinned admin/public Dockerfiles, `.dockerignore`, deterministic entrypoint/runtime preparation and non-root steady-state processes.
- [x] Add `deploy/docker/docker-compose.yml` with exact loopback bindings, healthchecks, restart policies, resource limits, read-only/rootfs/tmpfs where compatible, and separate named volumes for DB, uploads, previews, backups and article releases.
- [x] Mount Telegram OIDC and weekly-ingestion values only through Compose secret files; include safe examples/README and gitignore rules, never secret values.
- [x] Add the internal public nginx configuration that serves the bundled site and shared immutable article releases without exposing admin/private volumes.
- [x] Add static policy tests plus a live isolated build/smoke path that proves both ports and persistent-volume survival when Docker is available.

### Task 3: Add host nginx proxy configuration and Docker operations runbook

**Goal:** Give Zhenya a copy-ready host nginx/TLS setup and exact first-run/upgrade/backup/rollback commands.

**Serves:** Zhenya’s request for nginx `proxy_pass` on `admin.oknotika.ru` and `oknotika.ru`, plus Sanya’s request for a separate instruction file.

- [x] Add host nginx config with canonical HTTP→HTTPS redirects, `www` handling, exact upstreams `127.0.0.1:8000/8001`, admin request limits/rate limits and trusted proxy headers.
- [x] Document DNS/TLS prerequisites, secret-file creation with safe permissions, Compose startup, logs/health, Telegram enrollment, initial content/cover bootstrap and weekly draft smoke.
- [x] Document persistent-volume backup/restore, upgrade by immutable source/archive checksum, no-data-loss rollback, and emergency stop without deleting volumes.
- [x] Explicitly warn that `docker compose down -v`, public port binding and embedding credentials are forbidden.
- [x] Add documentation checks for exact domains, ports, callback, proxy headers and no-secret boundary.

### Task 4: Build and verify the Docker handoff archive

**Goal:** Produce one phone-friendly, secret-free package containing the public site, admin editor, Compose files, host nginx config and Russian instructions.

**Serves:** Sanya’s request to send Zhenya “и файл, и инструкцию” for a self-managed Docker deployment.

- [x] Add a deterministic builder and internal manifest/checksum for `oknotika-docker-v2.29.0-rc.3.zip` from the exact committed tree.
- [x] Include only required public paths, `admin-app`, Docker deployment files/runbook and validation metadata; exclude node_modules, runtime state, prior release ZIPs, raw portraits, evidence and credentials.
- [x] Add archive traversal/symlink/duplicate/secret/runtime/tamper checks and deterministic double-build tests.
- [x] Run the full suite, Docker build/isolated smoke, secret scan and final diff cut pass against the approved outcome and Non-goals.
