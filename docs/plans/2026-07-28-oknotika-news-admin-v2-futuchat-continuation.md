# Plan: Oknotika weekly news admin v2 — FUTUCHAT continuation

## Goal

Complete Sanya's same approved weekly-news/admin outcome after his 2026-07-28 requirement update: add FUTUCHAT as a fourth first-class configurable public CTA and ship the exact official Telegram, YouTube, VK and FUTUCHAT destinations through the already reviewed storage/admin/API/static-render/release architecture.

This is a narrow continuation of logical run `oknotika-site/news-admin-v2`, not a second repository or implementation scope.

## Exact approved public destinations

- Telegram: `https://t.me/oknotika`
- YouTube: `https://youtube.com/@oknotika`
- VK: `https://vk.ru/oknotika`
- FUTUCHAT: `https://t.me/FUTU_CHAT`

Sanya explicitly removed the mobile `m.` prefix from VK. `https://vk.ru/oknotika` is canonical; do not substitute or document a guessed `vk.com` URL. FUTUCHAT remains a separate field and CTA label although it uses the `t.me` host.

## Current reviewed baseline

- Branch `feature/news-admin-v2` is clean at `d8a5f39`.
- The completed parent plan is `docs/plans/completed/2026-07-28-oknotika-news-admin-v2.md`.
- Ralphex review completed clean after 101 application tests, 27 security tests, 22 release guardrails, deterministic release rebuild and secret scan.
- The current branch implements only Telegram/YouTube/VK social destinations; FUTUCHAT and the newly supplied exact YouTube/VK defaults are absent.

## Non-goals

- No CMS/framework rewrite.
- No change to Tuesday draft-only ingestion authority or Friday manual publication.
- No new authentication roles or public admin link.
- No generalized arbitrary social-network registry.
- No production DNS/TLS/OIDC/secret creation or server deployment.
- No second repository, bot-runtime change, analytics, comments, cross-posting or media upload.
- No destructive migration or loss of existing article/social/release history.

## Validation commands

```bash
cd admin-app
npm ci
npm run lint
npm test
npm run test:security
npm run build
npm run render:fixture
cd ..
python3 scripts/check_generated_articles.py
python3 scripts/check_local_refs.py
python3 scripts/check_deploy_package.py
python3 scripts/check_final_documentation.py
python3 scripts/build_release_zip.py
python3 scripts/scan_release_zip.py release/oknotika-final.zip
python3 -m unittest tests/test_release_guardrails.py tests/test_release_package.py
```

## Task 1: Add FUTUCHAT and exact official destinations end to end

**Goal:** Extend the reviewed four-layer social-link contract without weakening compatibility, security, release determinism or the private-admin/static-public boundary.

**Serves:** Sanya's direct correction that every weekly digest CTA must contain Telegram, YouTube, VK and FUTUCHAT using the exact official links he supplied.

- [ ] Add an additive/backward-compatible schema migration and service contract for `futuchatUrl`; existing databases/releases/articles must remain readable and rollback-safe.
- [ ] Seed or document the four exact non-secret official destinations where the architecture permits defaults. Preserve Telegram's current fixed rule; accept canonical `vk.ru`; validate FUTUCHAT separately while allowing its `t.me` host.
- [ ] Extend admin load/save UI, HTTP/API payloads, validation, immutable release manifests/hashes, renderer/templates, rollback/legacy normalization and ingestion/social snapshots to carry FUTUCHAT as a distinct optional CTA.
- [ ] Render all four configured CTAs with correct Russian labels; missing optional destinations must not create blank/broken links. Keep manual publication and draft-only ingestion authority unchanged.
- [ ] Add focused tests for the exact four URLs, `vk.ru`, FUTUCHAT host/path handling, partial configuration, round-trip persistence, public rendering, immutable release activation, rollback/legacy compatibility and ingestion capability boundaries.
- [ ] Update README, enrollment, Zhenya runbook, deployment smoke/config examples, release manifest/notes and weekly-ingestion docs so no text still claims YouTube/VK are pending.
- [ ] Run the full validation set, production dependency audit, deterministic double rebuild and secret scan; commit source and controlled release artifacts separately if required by the packager.
- [ ] Leave the worktree clean and move this plan to `docs/plans/completed/` only after review is objectively clean. PR/merge/deployment remain parent-owned.
