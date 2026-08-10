# Plan: безопасный CI/CD для ОКНОТИКИ

## Goal

Собрать в текущем репозитории полный, но не активированный CI/CD-контур для публичного сайта и закрытого редактора: проверка pull request без production-секретов, production deploy только из будущего защищённого `main` после ручного допуска GitHub Environment, доставка immutable artifact по commit SHA на сервер Жени, healthcheck и ограниченный автоматический rollback application/marketing symlinks при неуспехе.

## Approved outcome and constraints

- Саня подтвердил «Собираем» после предложения: PR → тесты/сборка/проверка секретов → merge в защищённый `main` → ручное подтверждение production → deploy по SHA → healthcheck → rollback.
- Контур охватывает публичный сайт и `admin-app/`.
- Production credentials, server facts and access are not available yet; implementation remains parameterized and fail-closed until Zhenya supplies them.
- Current source baseline is `feature/site-content-revision-20260802` at `c6a27dcbfb39076ff0e7f464335888ffc8c11c64`; PR #4 remains open and unmerged. This CI/CD work uses a stacked feature branch and must not merge or deploy.
- Existing `v2.29.0-rc.1` handoff remains historical. Because CI/CD adds release-payload deploy sources, the completed branch must produce a new secret-free `v2.29.0-rc.2` candidate rather than silently changing the already-delivered rc.1 archive.
- Repository default branch is currently `master`, unprotected. Production workflow targets future protected `main`; migration/protection is an operator rollout gate, not an implicit mutation during implementation.
- Production editor credentials remain systemd encrypted credentials outside GitHub Actions. GitHub receives only the restricted SSH deployment credentials and pinned host identity needed to invoke a root-controlled server deploy primitive.

## Non-goals

- No merge, default-branch rename, branch-protection mutation, GitHub Environment creation, production deployment, DNS/TLS change, server login, secret creation or editor enrollment in this implementation run.
- No deployment from feature branches, pull requests, tags or unreviewed workflow revisions.
- No self-hosted production runner, Kubernetes, containers, Terraform, cloud migration, repository transfer or generalized deployment framework.
- No automatic content/editorial rollback and no automation of breaking database migrations; ordinary releases remain additive/backward-compatible under existing checks.
- No credentials, Telegram subject, runtime DB/uploads/previews, weekly payloads, backups or raw portraits in workflows, artifacts, fixtures or logs.
- No unrelated redesign of the site, admin editor, auth, publishing or backup architecture.
- No ADR file until Sanya explicitly confirms “Record as ADR?”.

## Architecture choice

Use GitHub-hosted runners. Pull requests execute only secret-free CI. A production workflow runs only for `refs/heads/main`, reuses the same CI gate, builds one SHA-addressed secret-free deployment ZIP with an internal manifest/checksum, and enters a `production` GitHub Environment requiring Zhenya’s approval. The runner transfers the artifact over host-key-pinned SSH to a dedicated incoming directory and invokes a fixed root-owned `/usr/local/sbin/oknotika-deploy` through a narrowly scoped deploy account. Repository code cannot grant itself broader server privileges.

The server primitive serializes deployments with `flock`, validates SHA/checksum/archive boundaries, stages immutable application and marketing releases, preserves exact previous symlink targets, installs pinned application dependencies, runs preflight, switches application then marketing, restarts the existing systemd service, runs public/admin smoke checks, and restores previous symlinks/service if the post-switch gate fails. Initial host/DNS/credentials/enrollment/bootstrap remains Zhenya’s manual gate.

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
python3 scripts/check_cicd_package.py .
python3 scripts/build_ci_bundle.py --repo . --commit HEAD --output var/ci-bundle.zip
python3 scripts/check_ci_bundle.py var/ci-bundle.zip
bash -n deploy/cicd/oknotika-deploy
bash -n deploy/cicd/upload-and-deploy.sh
python3 scripts/scan_release_zip.py release/oknotika-final-v2.29.0-rc.2.zip
```

## Tasks

### Task 1: Secret-free PR validation workflow

**Goal:** Add a pinned, least-privilege GitHub Actions CI workflow that reproduces the canonical application/repository/deploy gates on pull requests and is callable by production CD.

**Serves:** Sanya’s approved requirement “PR → тесты, сборка, проверка секретов”.

- [x] Add `.github/workflows/ci.yml` with read-only permissions, concurrency, exact Node `24.18.0`, pinned third-party actions and no production environment/secrets on PRs.
- [x] Run the existing admin suite, repository/release tests, generated-article checks, deploy/final-documentation checks and dependency audit using pinned inputs.
- [x] Add minimum static checks/tests that fail if CI gains write permissions, secret access on PR, floating action tags or unsupported runtime versions.
- [x] Validate Task 1 with focused workflow-policy tests.

### Task 2: Immutable SHA-addressed deployment bundle

**Goal:** Build and validate one deterministic, secret-free production input from an exact committed tree rather than deploying the mutable checkout or a historical handoff ZIP.

**Serves:** Sanya’s approved requirement “deploy по SHA” and the existing no-secret/public-boundary constraints.

- [ ] Add a minimal bundle builder for the exact commit containing only public payload, `admin-app/`, required deploy sources and an internal SHA/file manifest; reject dirty or uncommitted payload inputs where applicable.
- [ ] Add bundle validation for traversal, symlinks, duplicates, secret/runtime paths, unexpected top-level content, checksum mismatch and implementation-SHA mismatch.
- [ ] Add focused deterministic/tamper/secret-boundary tests.
- [ ] Validate Task 2 by rebuilding twice from the same commit and comparing hashes.

### Task 3: Root-controlled server deploy and rollback primitive

**Goal:** Add a reviewed Linux operator primitive that installs both immutable releases, switches only validated symlinks, performs health checks and reverts application/marketing activation when the post-switch gate fails.

**Serves:** Sanya’s approved requirements “публичный сайт + редактор”, “healthcheck” and “откат”.

- [ ] Add `deploy/cicd/oknotika-deploy` with strict argument/path/SHA/checksum validation, archive boundary checks, `flock`, exact previous-target capture and fail-closed initial-bootstrap detection.
- [ ] Stage/install the application under `/opt/oknotika-admin/releases/<sha>` with pinned Node/npm rules, use the existing public allowlist installer for `/srv/oknotika/releases/<sha>`, restart the existing systemd service and run existing smoke checks.
- [ ] On post-switch failure, atomically restore only the captured application/marketing symlinks, restart the previous service and verify rollback health; preserve evidence and never mutate article/content release state.
- [ ] Add shell/static integration tests using isolated temporary roots and stubbed service/smoke commands; do not require root or a live server in CI.

### Task 4: Production workflow and Zhenya activation runbook

**Goal:** Connect the validated artifact to the fixed server primitive only through future protected `main` and manually approved `production`, while documenting every external gate needed to activate it safely.

**Serves:** Sanya’s approved requirements “защищённый main”, “подтверждение Жени для production” and “он сам всё заливал”.

- [ ] Add `.github/workflows/deploy-production.yml`: `main` only, reusable CI dependency, SHA bundle/checksum artifact, `production` Environment, single deployment concurrency, pinned SSH host identity and restricted remote invocation without production application credentials.
- [ ] Add a small upload/invoke helper that keeps private key material out of argv/logs, validates remote destination inputs and sends only the reviewed bundle/checksum.
- [ ] Document server account/root-script installation, exact GitHub secret names, required reviewer/environment settings, protected-main migration from current `master`, first manual bootstrap, evidence, routine deploy and emergency rollback.
- [ ] Extend deployment/final-documentation checks and tests so missing approval, branch restriction, host-key pinning, artifact checksum, rollback/runbook or no-secret boundaries fail CI.
- [ ] Build a new deterministic secret-free `v2.29.0-rc.2` candidate containing the reviewed CI/CD deploy sources; preserve rc.1 as the historical Zhenya handoff and update current release documentation consistently.
- [ ] Run the full suite and review the final diff against approved outcome and Non-goals.
