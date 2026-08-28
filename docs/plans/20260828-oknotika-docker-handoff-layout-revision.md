# Plan: Simplify the OKNOTIKA Docker handoff layout

## Goal

Revise the already validated Docker handoff so Zhenya receives one simple ZIP whose root contains exactly `admin-app/`, `public-app/`, and `deploy/`. Runtime project paths are `/var/home/oknotika/admin-app` and `/var/home/oknotika/public-app`; persistent admin data lives under `/var/home/oknotika/admin-app/data/`; `/var/home/oknotika/public-app/data/` is reserved but unused while the public site is static. The archive ships no external SHA256SUMS/checksum file or mandatory checksum commands, while internal build-time archive/security verification remains.

## Approved outcome and constraints

- Zhenya explicitly requested all deployment material under one non-root `deploy/` directory.
- Required archive root directories: `admin-app`, `public-app`, `deploy` and no wrapper directory or deployment files at archive root.
- `admin-app` contains editor application resources; `public-app` contains all static public resources; `deploy` contains only the Russian instruction, nginx files, Dockerfiles, Docker Compose and their required deployment helper files.
- Exact host project paths: `/var/home/oknotika/admin-app` and `/var/home/oknotika/public-app`.
- Exact data locations: `/var/home/oknotika/admin-app/data/` and reserved `/var/home/oknotika/public-app/data/`.
- Sanya approved the compromise: remove external SHA-256 files/check commands from the handoff, retain internal build verification that is not shipped or required from Zhenya.
- Existing exact domains/ports remain: `admin.oknotika.ru` → `127.0.0.1:8000`, `oknotika.ru` → `127.0.0.1:8001`.
- Current reviewed implementation baseline is `d3e743215ac7eaf49cae06b28ce4fd93e868b987` on `feature/oknotika-docker-compose-20260827`; PR #5 remains open.

## Non-goals

- No live deployment, server login, DNS/TLS/credential mutation, Telegram enrollment, merge or data migration.
- No removal of internal secret/path/tamper/determinism tests merely because user-facing checksums are removed.
- No shipping manifest/checksum/helper whose only purpose is asking Zhenya to verify SHA-256.
- No credentials, runtime DB/uploads/previews/backups/article releases, node_modules, prior ZIPs, raw portraits or CI evidence in the archive.
- No public binding of ports 8000/8001 and no typo domain `admin.okntoika.ru`.
- No named Docker volumes for application data in the revised handoff; host bind mounts must use the exact `/var/home/oknotika/.../data` hierarchy.
- No unrelated change to editor behavior, public design, OIDC policy, article publishing or the existing systemd deployment alternative.
- No new architecture abstraction or generalized packaging framework.

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
python3 scripts/build_docker_package.py --repo . --commit HEAD --output release/oknotika-docker-v2.29.0-rc.4.zip
python3 scripts/check_docker_archive.py release/oknotika-docker-v2.29.0-rc.4.zip
```

Also build the archive twice from the same commit and compare bytes internally; list archive roots and reject any top-level entry outside `admin-app/`, `public-app/`, `deploy/`. Run the isolated Compose smoke against a task-owned `/var/home/oknotika` substitute or a supported root override without weakening exact production defaults.

## Tasks

### Task 1: Restructure Compose and deployment paths

**Goal:** Make the extracted three-directory handoff run directly from `/var/home/oknotika` with bind-mounted persistent data.

**Serves:** Zhenya’s exact requested folder and server-path layout.

- [ ] Update Compose build contexts/Dockerfiles so app sources come from sibling `admin-app/` and `public-app/`, while every deployment artifact stays under sibling `deploy/`.
- [ ] Replace named data volumes with bind mounts rooted under `/var/home/oknotika/admin-app/data/`; mount only article releases read-only into the public service. Reserve/create `/var/home/oknotika/public-app/data/` but do not mount unnecessary static state.
- [ ] Move secret-file expectations under the admin data hierarchy or another documented private subdirectory that does not add a fourth archive root; archive only safe setup instructions/examples.
- [ ] Update internal/host nginx, Dockerfile-specific ignore files, entrypoint, smoke test and runbook for the new paths without public port exposure or credential leakage.
- [ ] Add focused static and live tests for exact layout, paths, permissions, restart persistence and public/private volume separation.

### Task 2: Produce a simple archive without user-facing checksums

**Goal:** Deliver a plain ZIP and separate instruction while preserving unshipped internal validation.

**Serves:** Zhenya’s request to remove SHA-256 checks and Sanya’s approved internal-verification compromise.

- [ ] Change the deterministic builder to map committed sources into exactly three archive roots: editor → `admin-app/`, static site → `public-app/`, Docker/nginx/runbook/helpers → `deploy/`.
- [ ] Remove the wrapper root, shipped manifest, `.sha256` sidecar, `SHA256SUMS`, checksum installation steps and checksum-dependent upgrade naming from the user handoff/runbook.
- [ ] Keep internal traversal/symlink/duplicate/secret/runtime/path/determinism checks; update tests so archive integrity is proven before delivery without asking Zhenya to run SHA commands.
- [ ] Build and validate a new `v2.29.0-rc.4` Docker ZIP, preserve rc.3 as historical, and produce a standalone static Russian HTML instruction matching the simple layout.
- [ ] Run the full suite and final diff cut pass against this plan and the original Docker security boundaries.
