# Plan: Oknotika weekly news admin v2

## Goal

Extend the already reviewed Telegram-login editorial admin so Sanya can receive an automatically created Tuesday weekly-news draft, edit and preview it from a phone, and manually publish it Friday at 18:00 to a public `Новости` section as `Дайджест недели`, with verified source links and global Oknotika Telegram/YouTube/VK calls to action.

Preserve the existing static-public-site / private-admin security architecture and keep the public site available when the admin service is down.

## Approved outcome and constraints

- Tuesday 12:00 MSK remains the weekly package/draft creation time.
- Friday 18:00 MSK is the intended publication time; publication remains Sanya's explicit manual action.
- Public section name: `Новости`.
- Weekly material label: `Дайджест недели`.
- The same research run should create a private draft automatically after generating the presenter PDF.
- Sanya remains the initial Telegram-OIDC allowlisted editor.
- Telegram channel URL is `https://t.me/oknotika`; exact YouTube and VK URLs will be supplied later and must be configurable without code edits.
- Zhenya is the production DNS/server operator.
- No secrets in Git, logs, test fixtures, release ZIPs, Telegram, generated public files or documentation examples.

## Current verified baseline

- Exact reviewed base branch: `feature/final-site-telegram-admin` at commit `5884cd6`.
- Current implementation already has Telegram OIDC/PKCE, editor allowlisting, draft/revision/preview/publish/withdraw, safe cover upload, immutable static article releases, release rollback, nginx/systemd/deploy/backup runbooks and a reviewed release package.
- Current admin is plain, branded `Факт недели`, supports one optional source URL, exposes operational rollback in the editorial dashboard and has no machine-to-machine weekly-draft ingestion.
- `admin.oknotika.ru` is not production-deployed; production rollout is a separate parent-owned operational stage after this code increment.

## Non-goals

- No CMS/framework rewrite.
- No automatic public publishing or scheduled Friday publish.
- No public admin link.
- No additional editors, roles or generalized RBAC.
- No Minime/bot-runtime changes and no second repository implementation scope.
- No analytics, comments, newsletter, cross-posting or video upload automation.
- No destructive database migration or deletion of existing articles/releases.
- No production DNS/TLS/credential creation inside Ralphex; Zhenya and the parent supervisor own deployment.

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

## Tasks

### Task 1: Add the weekly-news content contract and secure draft ingestion

**Goal:** Represent weekly digests with multiple verified sources and configurable social destinations, and allow the Tuesday pipeline to create or update one private weekly draft idempotently without gaining publish authority.

**Serves:** Sanya's request that each Tuesday news run automatically creates an editable site draft with Telegram, YouTube and VK links while he remains the person who publishes Friday.

- [x] Add only additive/backward-compatible storage and validation needed for the weekly digest, multiple source URLs and global social URLs.
- [x] Add a narrowly scoped, authenticated machine-ingestion path or equivalent reviewed mechanism that can create/update a weekly draft but cannot preview private data, publish, withdraw, restore, rollback, manage editors or change unrelated articles.
- [x] Make retries idempotent for the same weekly issue and protect manual edits from silent overwrite with an explicit conflict/version rule.
- [x] Keep ingestion credentials outside environment files committed to Git and document the supported encrypted credential path for both server and cron-side caller.
- [x] Add tests for authentication failure, oversized/invalid payloads, URL validation, retry/idempotency, edit conflicts and proof that ingestion cannot publish.
- [x] Validate the task outcome with the narrow relevant test set before continuing.

### Task 2: Make the Telegram admin a simple mobile weekly-news editor

**Goal:** Give Sanya a clear Russian mobile-first flow for reviewing and editing the generated draft.

**Serves:** Sanya's request to sign in through Telegram and personally edit/site-publish updates without touching files or deployment tooling.

- [x] Rename the editorial surface to `Новости` and the weekly template/material to `Дайджест недели`.
- [x] Add a focused weekly-digest form for title, publication date, lead, body, cover/alt, multiple sources and social CTA configuration/status.
- [x] Show clear `Черновик`, `Предпросмотр`, `Опубликовано` state, last-change information and the public URL when available.
- [x] Preserve create/edit/preview/publish/withdraw/revision restore while moving whole-release operational rollback out of the everyday editorial screen.
- [x] Add restrained mobile-first styling consistent with the Oknotika site; keep the admin usable without a frontend framework.
- [x] Add/update UI and HTTP tests, including edit after automatic ingestion and manual Friday publish.

### Task 3: Render the public `Новости` / `Дайджест недели` experience

**Goal:** Publish concise weekly digests with source credibility and a reusable social CTA while preserving existing public article compatibility.

**Serves:** Sanya's request for a short site version that points readers to the full voiced news in Telegram, YouTube and VK.

- [x] Rename public navigation/headings from `Факт недели` to `Новости`; label weekly cards/articles `Дайджест недели`.
- [x] Render 3–5-item editorial digest content, a clean multiple-source list and a final social CTA using configured exact URLs only.
- [x] Handle not-yet-configured YouTube/VK destinations without broken or invented public links.
- [x] Keep canonical/OG metadata, `latest.json`, homepage latest-news block, withdrawn behavior and existing imported article compatibility valid.
- [x] Add rendering/contract/link tests for desktop and mobile output and for missing/partial social configuration.

### Task 4: Package a deployable reviewed increment for Zhenya

**Goal:** Produce a secret-free release and decision-complete operator instructions for the parent/Zhenya production rollout.

**Serves:** Sanya's request to get Telegram-login self-publishing live with Zhenya handling server and DNS.

- [x] Update the deploy manifest, environment/credential examples, Zhenya runbook, enrollment steps and smoke tests for the weekly-draft ingestion and renamed public section.
- [x] Document the exact production gates still requiring Zhenya: DNS/TLS, pinned runtime, encrypted OIDC/ingestion/backup credentials, Sanya enrollment, nginx/systemd validation, live auth smoke, ingestion smoke and restore drill.
- [x] Run the full validation command set, rebuild the release, scan it for secrets/private runtime data and verify public-only versus technical-package boundaries.
- [x] Review the final diff for scope, secret leakage, backwards compatibility and accidental changes to the approved V2.28 public composition.
- [x] Commit task-owned files and leave release/deploy/PR lifecycle to the parent supervisor.
