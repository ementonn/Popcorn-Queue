# PTP Submit And Restore Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the upload loop so a prepared job can be reviewed, edited, submitted to PTP, and restored/reseeded safely.

**Architecture:** Core owns persisted review draft and submit result contracts. Integrations owns the PTP form submitter with injectable fetch and no real-network tests. Worker owns upload-tail execution through an injected submitter, while API persists draft/upload results and exposes review/update/reseed endpoints. Web owns editing draft fields and showing source/upload torrent roles with original source filenames.

**Tech Stack:** TypeScript, Fastify, Prisma/SQLite, React/Vite, Vitest, Playwright, qBittorrent Web API, PTP legacy upload form.

---

## File Map

- Create `packages/core/src/review-draft.ts`: review draft defaults, patch normalization, PTP upload result types.
- Modify `packages/core/src/index.ts`: export review-draft contracts.
- Create `packages/integrations/src/ptp/submitter.ts`: PTP login, cookie, form construction, success/error parsing.
- Create `packages/integrations/src/ptp/submitter.test.ts`: mocked fetch tests only.
- Modify `packages/integrations/src/index.ts`: export submitter.
- Modify `apps/worker/src/phases.ts`: add `ptpSubmitter`, review draft input, upload phase implementation, `runUploadTail`.
- Modify `apps/worker/src/phases.test.ts`: fake submitter upload-tail tests.
- Modify `apps/api/src/jobs.ts`: persist `reviewDraft`, update endpoint behavior, upload success/failure transitions, restore validation helpers.
- Modify `apps/api/src/persistence.ts` and `apps/api/prisma/schema.prisma`: persist `review_draft`.
- Modify `apps/api/src/preparation.ts`: initialize review draft from preparation artifacts.
- Modify `apps/api/src/server.ts`: `PATCH /api/jobs/:id/review-draft`, real start-upload orchestration, restore validation, reseed status.
- Modify API tests for draft persistence, upload, restore/reseed.
- Modify `apps/web/src/types.ts`, `apps/web/src/api.ts`, `apps/web/src/components/ReviewPanel.tsx`, and `apps/web/src/styles.css`: editable draft and torrent role labels.
- Modify `apps/web/e2e/ui.spec.ts`: cover draft editing and source torrent display.
- Modify `apps/userscript/popcorn-queue-bridge.user.js`: preserve source torrent filename from `Content-Disposition`.
- Modify docs and `.env.example`: document PTP submit and source torrent display name behavior.

## Tasks

### Task 1: Core Draft Contract

- [ ] Write failing tests in `packages/core/src/review-draft.test.ts` for draft initialization from upload plan/artifacts and patch normalization.
- [ ] Run `npm test -- packages/core/src/review-draft.test.ts` and confirm failures.
- [ ] Implement `ReviewDraft`, `ReviewDraftPatch`, `PtpUploadResult`, `buildReviewDraft`, and `mergeReviewDraft`.
- [ ] Export from `packages/core/src/index.ts`.
- [ ] Run `npm test -- packages/core/src/review-draft.test.ts` and `npm --workspace @popcorn-queue/core run typecheck`.
- [ ] Commit `feat(core): add review draft contract`.

### Task 2: PTP Submitter Integration

- [ ] Write failing mocked tests for form fields, successful redirect parsing, upload-page error parsing, and `TfaRequired`.
- [ ] Run `npm test -- packages/integrations/src/ptp/submitter.test.ts` and confirm failures.
- [ ] Implement `PtpFormSubmitter` with injectable fetch, simple cookie persistence, redacted errors, `file_input`, and legacy PTP fields.
- [ ] Export it from integrations.
- [ ] Run `npm test -- packages/integrations/src/ptp/submitter.test.ts` and `npm --workspace @popcorn-queue/integrations run typecheck`.
- [ ] Commit `feat(integrations): submit ptp upload form`.

### Task 3: Worker Upload Tail

- [ ] Write failing worker tests showing `runUploadTail` calls a fake submitter and upload phase fails cleanly without a submitter.
- [ ] Run `npm test -- apps/worker/src/phases.test.ts` and confirm failures.
- [ ] Add `ptpSubmitter` to phase context and implement upload phase using `reviewDraft`, upload torrent path, and upload media artifacts.
- [ ] Add `PhaseRunner.runUploadTail`.
- [ ] Run `npm test -- apps/worker/src/phases.test.ts` and `npm --workspace @popcorn-queue/worker run typecheck`.
- [ ] Commit `feat(worker): run ptp upload tail`.

### Task 4: API Draft, Upload, Restore

- [ ] Write failing API and persistence tests for review draft persistence, patch endpoint, upload success/failure with fake submitter, missing restore files, and reseed handoff.
- [ ] Run targeted API tests and confirm failures.
- [ ] Add `review_draft` persistence and repository methods.
- [ ] Initialize `reviewDraft` when preparation reaches review.
- [ ] Wire `PATCH /api/jobs/:id/review-draft`.
- [ ] Change `POST /api/jobs/:id/start-upload` to run upload tail with `PtpFormSubmitter` when configured.
- [ ] Validate restored manifest files and retain `needs_reseed` behavior for valid done jobs.
- [ ] Run targeted API tests and `npm --workspace @popcorn-queue/api run typecheck`.
- [ ] Commit `feat(api): execute reviewed ptp uploads`.

### Task 5: Web Draft Editor And Torrent Labels

- [ ] Write failing Playwright expectations for editable draft fields and source torrent original filename display.
- [ ] Run `npm run test:e2e -- --project=chromium-desktop apps/web/e2e/ui.spec.ts` and confirm failures.
- [ ] Add draft types/API call.
- [ ] Add compact Upload Draft editor to `ReviewPanel`.
- [ ] Label `Source torrent` with `job.torrent.filename` and `PTP upload torrent` with `job.artifacts.uploadTorrent`.
- [ ] Run web unit/typecheck and desktop Playwright.
- [ ] Commit `feat(web): edit upload draft before ptp submit`.

### Task 6: Userscript Filename Preservation

- [ ] Write or update userscript-focused assertions if present; otherwise validate by static code inspection and API multipart test.
- [ ] Change `downloadTorrent`/`downloadMTeamTorrent` to return `{ bytes, filename }`.
- [ ] Parse `Content-Disposition` filenames for PTer/TJUPT/etc. and use site/id fallback before `source.torrent`.
- [ ] Ensure `POST /api/browser/jobs` preserves the submitted filename.
- [ ] Run `npm test -- apps/api/src/server.test.ts`.
- [ ] Commit `feat(userscript): preserve source torrent filenames`.

### Task 7: Documentation And Final Verification

- [ ] Update `.env.example`, `docs/api.md`, `docs/architecture.md`, and `docs/manual-testing.md`.
- [ ] Run full verification: `npm test`, `npm run typecheck`, `npm run build`, `npm run test:e2e`.
- [ ] Restart API and web on `0.0.0.0` and smoke-test `/api/health`, `/api/jobs`, and `/`.
- [ ] Commit docs if changed.
