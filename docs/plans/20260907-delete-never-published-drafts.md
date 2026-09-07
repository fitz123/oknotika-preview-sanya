# Plan: Permanent deletion of never-published drafts

## Goal

Let the single Oknotika editor permanently delete an abandoned article draft from the editorial queue when that article has never been public. Deletion must be explicit, irreversible, and safe: it removes the private draft and its owned dependent records/files without changing any active public release, while every article that is published, withdrawn, or otherwise has public history remains undeletable.

## Non-goals

- Do not add archive, trash, restore-after-delete, retention schedules, bulk deletion, or RBAC.
- Do not allow deletion of published, withdrawn, or ever-public articles; those continue to use withdrawal and immutable public history.
- Do not redesign login, sessions, publishing, weekly ingestion, or the public site.
- Do not delete shared assets, unrelated previews, release data, backups, or audit history belonging to other materials.
- Do not perform production deployment in Ralphex; the parent performs backup, rollout, smoke testing, and rollback verification separately.

## Context

- Sanya explicitly chose option 2: permanent deletion rather than archive, because test and abandoned drafts otherwise accumulate in the queue.
- Current schema deliberately blocks deletion of `article_revisions` and `article_revision_sources`; any migration must keep published/public history immutable and relax deletion only for a provably never-public parent article.
- Public history is represented by `articles.public_state`, `articles.published_revision_id`, `release_articles`, and publish/withdraw audit events. All relevant evidence must be checked in the deletion transaction, not inferred from the current `state` alone.
- The UI currently exposes edit, preview, publish, withdraw, and restore actions through `handler.js`, `admin.js`, `admin-actions.js`, and `node-adapter.js`.
- The delete action must require the current revision ID and an exact destructive confirmation value, reject stale forms, and be idempotency-safe only through an explicit not-found result (never silently delete the wrong row).
- Remove only upload/assets proven unreferenced after the draft records are gone. Filesystem cleanup must not create a partial database deletion or delete a shared file. Private preview cleanup may remove only preview directories that can be proven to belong to the deleted draft/revisions; unknown or unrelated previews are left intact and reported by retained audit details rather than guessed.

## Validation Commands

```bash
cd admin-app
node --test --test-reporter=spec tests/http-security.test.js tests/content.test.js tests/admin-client.test.js tests/deploy.test.js
npm run test:security
npm test
npm run lint
cd ..
python3 -m unittest discover -s tests -p 'test_*.py'
git diff --check
```

## Tasks

### Task 1: Add a deletion-safe schema and domain operation

**Goal:** Permanently remove only a never-published draft and its exclusively owned private dependencies while preserving all public and shared state.

**Serves:** Sanya's choice of permanent deletion for abandoned drafts, with the explicit boundary that published history must remain immutable.

- [x] Add the smallest forward-only migration needed to permit revision/source deletion only when the parent article is provably never public; retain hard database rejection for published, withdrawn, release-linked, or ever-public content.
- [x] Add a transactional content-service operation requiring an enabled editor, exact article ID, expected current revision ID, and never-public evidence checks (`public_state`, `published_revision_id`, release membership, and public transition history).
- [x] Delete dependent weekly-ingestion/source/revision/article records in safe FK order and retain a non-content audit tombstone that records the deletion event without retaining deleted body content or creating dangling foreign keys.
- [x] Remove only assets/private uploads no longer referenced by any remaining revision. Coordinate private file deletion so failure cannot remove a shared file or silently leave the database in an ambiguous partial state.
- [x] Remove only private preview artifacts that are demonstrably tied to the deleted draft/revisions; never broad-delete unknown preview directories.
- [x] Validate successful deletion, stale revision rejection, shared-asset preservation, weekly-draft cleanup, and hard rejection for current or historical public content.

### Task 2: Expose an explicit destructive editor action

**Goal:** Show and execute permanent deletion only for eligible never-published drafts.

**Serves:** Sanya and Evgeny's request for a visible delete option so abandoned drafts do not accumulate.

- [x] Add a bounded authenticated API route for deleting a draft, include it in pre-body mutation admission, and require the exact destructive confirmation plus `expectedRevisionId`.
- [x] Add a clearly destructive `Удалить навсегда` action only when `public_state` and public-history eligibility allow it; never render it for published/withdrawn/ever-public items.
- [x] Add a Russian irreversible confirmation prompt, call the API once, report success/failure plainly, and reload the queue after success.
- [x] Preserve existing edit, preview, publish, withdraw, restore, CSRF, session, body-limit, and error contracts.

### Task 3: Prove lifecycle, safety, and rollback compatibility

**Goal:** Demonstrate that deletion cleans the private queue without touching public output or weakening immutable history.

**Serves:** Sanya's requirement for real cleanup and the standing production/data-retention constraints.

- [ ] Add HTTP/client/domain/migration tests for the success path and all refusal boundaries, including direct SQL attempts against public history.
- [ ] Test that an active public release and rendered public files remain byte/logically unchanged after deleting an unrelated never-published draft.
- [ ] Test orphan versus shared asset behavior and failure handling for private-file cleanup.
- [ ] Verify the migration remains readable by the current rollback application where applicable; document any exact rollback boundary rather than adding speculative machinery.
- [ ] Run the focused validation commands and leave the branch clean with task-owned commits only.
