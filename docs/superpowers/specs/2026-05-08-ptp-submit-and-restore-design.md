# PTP Submit And Restore Closure Design

## Scope

This change closes the current upload loop for Popcorn Queue by implementing the approved A+B scope: editable review drafts, explicit PTP submission, clearer torrent semantics, and restore/reseed validation. Metadata enrichment, BDInfo/disc support, archive extraction, and new torrent creation remain outside this scope.

## Goals

The operator should be able to send a source torrent from the userscript, let the backend prepare the upload package, review screenshots, MediaInfo, qB status, and editable upload fields, then press `Start Upload` to submit to PTP. Automated tests must never submit to real PTP; all PTP and qB behavior in tests must use mocked clients.

Restored jobs should validate that the files needed for upload and reseed exist. If a restored `done` job is not present in qB, the API should mark it `needs_reseed`, and `/api/jobs/:id/reseed` should push the upload torrent back to qB using `media/upload` as the save path.

## Upload Draft Model

Each job gains a persisted `reviewDraft` object. It is initialized from worker artifacts and upload-plan data when preparation reaches review, and it can be patched from the web UI before upload. The draft contains the final values used by PTP submit:

- `releaseName`
- `description`
- `groupId`
- `type`
- `codec`
- `container`
- `resolution`
- `source`
- `remasterYear`
- `remasterTitle`
- `subtitles`
- `trumpable`
- `scene`
- `personalRip`
- `internal`

The API exposes `PATCH /api/jobs/:id/review-draft`. Patches are merged into the existing draft and written to persistence. Review gates are not silently resolved by editing draft fields; the operator still controls blocker resolution explicitly.

## PTP Submitter

The PTP submitter lives in `packages/integrations` beside the existing PTP API search client. It uses the legacy PtpUploader form contract:

- login through `https://passthepopcorn.me/ajax.php?action=login`
- reuse a cookie jar file if configured
- read `AntiCsrfToken` from the cached upload page or login response
- post to `https://passthepopcorn.me/upload.php` for a new group, or `https://passthepopcorn.me/upload.php?groupid=<id>` for an existing group
- send torrent file field `file_input`
- send `type`, `codec`, `container`, `resolution`, `source`, custom `other_*` values, `release_desc`, `nfo_text`, `subtitles[]`, `trumpable[]`, and `AntiCsrfToken`

The submitter returns `{ groupId, torrentId, ptpUrl }` on success. If the response remains on the upload page or contains an alert error, it throws a typed error with a redacted message. It never logs credentials, cookies, passkeys, or announce URLs.

Two-factor login is not implemented in this scope because an interactive prompt would not work reliably inside the API service. If PTP returns `TfaRequired`, the submitter fails with an explicit message telling the operator to provide a valid cookie file or run a login flow outside the service.

## Worker And API Flow

`Start Upload` becomes a real upload operation. The API first validates the job is review-ready and has no open blocker gates, then runs only the upload tail of the worker: `upload -> post-hook -> done`. The upload phase reads `reviewDraft`, `artifacts.uploadTorrent`, and `media/upload` evidence. The worker calls an injected submitter from API configuration, so tests can inject a fake submitter and never touch PTP.

On success, the job transitions to `done`, records `artifacts.ptpUrl`, `artifacts.ptpGroupId`, and `artifacts.ptpTorrentId`, writes a job log entry, and leaves the upload torrent ready for qB reseed. On failure, the job transitions to `failed`, keeps all artifacts and draft data for retry, and records the sanitized error.

## Torrent And Restore Semantics

The internal paths stay stable:

- `torrent/source.torrent` is the source-site torrent submitted by the browser bridge.
- `torrent/upload.torrent` is the PTP upload torrent.
- `media/upload/` is the upload-ready media directory.
- `download/` is the source qB download and may be large.

The UI should stop presenting `source.torrent` as a meaningful user-facing filename. It should label these paths as `Source torrent` and `PTP upload torrent`, and optionally show the original filename from job metadata.

The source torrent display name must come from the source-site download when available. The browser bridge should parse `Content-Disposition` from the source torrent response and submit that filename in the multipart upload. If the source site does not provide a filename, the bridge should use a stable fallback derived from site and source torrent id, and only then fall back to `source.torrent`. The backend still writes the bytes to `torrent/source.torrent`, but preserves the submitted filename in `job.torrent.filename` and `input/source.json`; the web UI displays that original filename beside the `Source torrent` role label.

Restore validation checks `manifest.json`, every `uploadFiles` entry, and `torrentFile` if present. Missing upload media blocks automatic reseed and puts the job in review with a warning. A restored `done` job with valid upload media and upload torrent becomes `needs_reseed`; `/api/jobs/:id/reseed` adds `torrent/upload.torrent` to qB with `media/upload` as save path and marks the job `seeding` only after qB accepts it.

## Web UI

The Review panel gains an editable Upload Draft section. It uses compact controls matching the current QUI-style shell: text inputs for title/group/remaster, selects for type/codec/container/source/resolution, checkboxes for scene/internal/personal, and multi-value text fields for subtitles and trumpable reasons. Saving the draft calls `PATCH /api/jobs/:id/review-draft`; `Start Upload` uses the saved draft.

The Torrent/qB section labels the paths by role instead of showing only `source.torrent` or `upload.torrent`. Restore/reseed state is visible as a short status row, with the existing Diagnostics panel still owning low-level debug controls.

## Testing

Tests must cover:

- draft initialization and PATCH persistence in memory and Prisma repositories
- PTP submit form construction, successful redirect parsing, upload-page error extraction, and 2FA failure using mocked fetch/session behavior
- API `Start Upload` with fake submitter, including success and failure transitions
- restore validation for missing files and reseed handoff to fake qB
- web UI editing draft fields and rendering torrent role labels through Playwright

No test may call real PTP, qB, image hosts, or external media services.
