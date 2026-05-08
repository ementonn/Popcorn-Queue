# Pre-Upload Automation Design

## Purpose

Popcorn Queue should feel like an upload preparation system, not a phase debugger. Creating a job should automatically prepare a complete upload package and stop before the irreversible PTP upload action. The operator should review blockers, warnings, screenshots, MediaInfo, release text, duplicate results, torrent readiness, and seeding readiness, then explicitly choose `Start Upload`.

This design also removes UI noise that does not help daily decisions. Permanent PTP cache details, roadmap states such as `planned`, and internal phase controls should not appear in the main upload workflow.

## Current Problems

The current UI exposes implementation details as primary controls and status. It shows permanent cache state even though permanent cache is now expected behavior. It shows `Upsies features`, `planned`, and `safe-default` statuses in the main inspector, which are development roadmap signals rather than upload decisions. It also relies on `Advance phase`, which makes the operator manually move an upload through internal phases instead of letting the system prepare the upload package.

The current logging model has a global API file log, but it does not yet define per-job logs that travel with a copied job folder.

## Target Lifecycle

The main job lifecycle is:

```text
created
  -> preparing
  -> review | failed | paused
  -> uploading
  -> done | needs_reseed
```

Creating a job immediately enqueues preparation. The runner executes preparation phases automatically until the upload package is ready for review or no more safe progress can be made.

`review` is the human approval state. A reviewed job has `uploadReadiness` set to `blocked`, `ready`, or `missing_evidence`. `Start Upload` is enabled only when `uploadReadiness` is `ready`.

The preparation phases are:

```text
intake
duplicate-check
metadata
download-or-locate
prepare-media
inspect-media
screenshots
image-host-upload
torrent-create
seed-prepare
preflight
review
```

The final public action is separate:

```text
Start Upload -> upload -> post-hook -> done
```

`prepare-media` is a real file preparation phase. It creates the final upload media in the job workspace. It hardlinks or copies media when the source can be uploaded directly, remuxes MP4 to MKV, and normalizes the upload target for later phases.

`inspect-media` is read-only. It runs MediaInfo, BDInfo, ffprobe, or similar tools against the final upload media and writes technical evidence for review.

Screenshots are generated from the final upload media, not from the original source download.

## Workspace And Backup Structure

The workspace separates disposable source downloads from copyable job artifacts.

```text
data/
  sources/
    <source-id>/
      download/
      source.torrent
      source.json

  jobs/
    <job-id>/
      input/
        source-ref.json
        source.torrent
      media/
        upload/
          Movie.2024.1080p.BluRay.x264-GROUP.mkv
        intermediates/
      screenshots/
        raw/
        optimized/
        hosted.json
      torrent/
        upload.torrent
        reuse-report.json
      metadata/
        mediainfo.json
        mediainfo.txt
        bdinfo.txt
        description.md
        release-name.txt
        ptp-duplicate.json
        rules.json
      logs/
        job.log
        phases.jsonl
        external.jsonl
      manifest.json
```

`data/sources/<source-id>/download` is an original download cache and is not meant to be backed up. The job folder is self-contained and can be copied directly for backup. `media/upload` must contain real files produced by hardlink, copy, or remux. It must not contain symlinks as the primary restore path.

Restoring a job means copying `data/jobs/<job-id>` back and importing its `manifest.json`. If `source-ref.json` points to a missing source download, the restore still succeeds. The restored job can review existing artifacts, upload if it was not uploaded, and reseed from `media/upload`.

If a restored job is already `done` but qBittorrent no longer has the torrent, it becomes `needs_reseed`. The worker should automatically push `torrent/upload.torrent` back to qBittorrent with `media/upload` as the save path. Success returns the job to `done` or `seeding`; failure records `reseed failed` and exposes `Retry reseed`.

## Runner Behavior

The runner owns automatic preparation. It executes phases by dependency, not by manual `advance` clicks. Each phase writes artifacts to the job folder and writes structured output to SQLite.

Each phase has:

- `phase`
- `state`: `pending | running | done | warning | failed | skipped`
- `attempts`
- `canContinueAfterFailure`
- `blocksUpload`
- `outputs`
- `warnings`
- `error`

Failures are handled by policy. Low-risk transient failures retry automatically. If a failed phase does not block unrelated phases, the runner continues with other work and collects missing evidence for review. Only problems that would create an invalid upload package block `Start Upload`.

The normal operator actions are:

- `Pause`
- `Retry failed steps`
- `Refresh plan`
- `Start Upload`
- `Retry reseed`

Debug actions such as `Advance phase`, `Skip`, and `Force state` are removed from the main UI and moved to Diagnostics.

## Review Gates And Upload Decision

Review gates are the contract between automation and human approval.

Gate severities are:

- `blocker`: prevents `Start Upload`
- `warning`: can be accepted by the operator
- `info`: visible evidence or context

Examples of blockers include missing final upload media, full PTP slot, failed torrent creation, and missing required description fields. Examples of warnings include uncertain scene check, partial metadata enrichment, non-critical MediaInfo gaps, or fewer screenshots than preferred.

The review page should clearly explain what blocks upload and what merely needs operator judgment. `Start Upload` is enabled only when blockers are resolved or fixed and `uploadReadiness` is `ready`.

## Main UI Information Architecture

The main UI is an upload decision workbench.

Remove from the main UI:

- PTP cache permanent/hit/filter
- `Upsies features`
- `planned`, `implemented`, and `safe-default` roadmap states
- `Advance phase` and other internal phase controls
- phase implementation details that do not affect upload decisions

Queue rows should focus on:

- title
- state
- human step
- blocker/warning counts
- source
- updated time
- primary action

Primary actions map to user intent:

- `preparing`: `Pause`
- `review` with blockers: `Resolve blockers`
- `review` with missing evidence: `Retry failed steps`
- `review` with `uploadReadiness=ready`: `Start Upload`
- `failed`: `Retry failed steps`
- `done`: `Open PTP`
- `needs_reseed`: `Retry reseed`

The review panel order is:

1. Blockers
2. Warnings
3. Duplicate/PTP result
4. Screenshots
5. MediaInfo / BDInfo
6. Release name and description draft
7. Torrent/qB readiness
8. Recent job log summary

The main UI should not use `cache`, `permanent`, `planned`, or `Upsies roadmap` language. Cache behavior is operational background. Rechecking remains available through the browser bridge and diagnostics.

## Diagnostics UI

Diagnostics is for troubleshooting and development controls. It shows:

- API health
- worker health
- PTP, ImgBB, PTPImg, qBittorrent, and tool configuration status
- full phase list
- raw phase output
- global logs
- per-job logs
- debug controls: advance, skip, force retry, force state, import job folder, reseed

Diagnostics should be clearly separated from the normal upload workflow.

## Logging Design

Logging has two levels: global system logs and per-job logs.

Global logs live under:

```text
logs/
  api.log
  worker.log
  scheduler.log
```

Global logs answer system questions: API requests, authentication failures, service startup, worker scheduling, queue-level failures, and process-level errors.

`scheduler.log` is created only when a separate scheduler process exists. Until then, scheduling events can be written by the worker log with the same redaction rules.

Per-job logs live under:

```text
data/jobs/<job-id>/logs/
  job.log
  phases.jsonl
  external.jsonl
```

Per-job logs answer upload-package questions: what happened to this job, which phase ran, which tool was called, what artifact was produced, what failed, and why the job is blocked or ready.

`job.log` is a human-readable event stream. `phases.jsonl` is structured phase state and output. `external.jsonl` records sanitized summaries of PTP, ImgBB, qBittorrent, ffmpeg, MediaInfo, BDInfo, and related external calls.

Secrets must never be written to logs. Browser tokens, PTP API keys, PTP passwords, ImgBB keys, PTPImg keys, qBittorrent passwords, cookies, and authorization headers are redacted.

The main review UI shows only the latest important job events. Job Diagnostics shows the full per-job logs. Global Diagnostics shows global API and worker log tails.

Because job logs live inside `data/jobs/<job-id>`, copying a job folder for backup also copies the audit trail needed to understand and restore the job. Global logs are not part of job backup.

## API And Data Model Changes

The API should expose intent-level endpoints for the main workflow:

- `POST /api/jobs/:id/pause`
- `POST /api/jobs/:id/retry-failed`
- `POST /api/jobs/:id/review-gates/:gateId/accept`
- `POST /api/jobs/:id/review-gates/:gateId/resolve`
- `POST /api/jobs/:id/start-upload`
- `POST /api/jobs/import`
- `POST /api/jobs/:id/reseed`

Debug endpoints can remain for Diagnostics:

- `POST /api/jobs/:id/debug/advance`
- `POST /api/jobs/:id/debug/skip`
- `POST /api/jobs/:id/debug/force-state`

The API should return machine state, `uploadReadiness`, and human-facing state. The UI should prefer `humanStep` for display and use raw phase state only in Diagnostics.

## Error Handling

Errors are classified by upload impact.

`blocking` errors prevent upload. Examples include missing final media, full duplicate slot, failed torrent creation, and invalid upload description.

`warning` errors require human judgment but do not automatically prevent upload. Examples include uncertain scene results or incomplete optional metadata.

`non-blocking failed evidence` is recorded but does not stop independent phases. Optional provider failures are in this category.

`external unavailable` is used for qBittorrent, ImgBB, PTP, and tool availability problems. These produce retry actions and diagnostics entries.

The runner should retry transient failures automatically before surfacing them. It should not loop forever. Retry counts and last error are recorded in phase output and job logs.

## Testing Strategy

Unit tests cover:

- job state machine from creation to review with `uploadReadiness` set correctly
- phase dependency and failure continuation rules
- workspace path and manifest generation
- restore from copied job folder
- done job missing qBittorrent state becoming `needs_reseed`
- log redaction and per-job log path generation

Integration tests cover:

- API job creation enqueues automatic preparation with fake phase handlers
- `Start Upload` is disabled when blockers exist
- `Start Upload` runs only the upload phases after review approval
- diagnostics debug actions do not leak into the main workflow
- job import and reseed behavior

Playwright tests cover:

- main UI does not show cache/permanent/planned/Upsies roadmap text
- review panel appears in the agreed order
- `Start Upload` is visible only when ready
- screenshots, MediaInfo, release draft, duplicate result, and qB readiness appear before upload
- Diagnostics contains health, phase, log, and debug controls

External systems remain mocked in automated tests. Real PTP, ImgBB, qBittorrent, and tool execution are manual-test only through `.env`.

## Non-Goals

This design does not implement the full PTP upload client. It defines the lifecycle and UI shape needed before that implementation. It also does not introduce distributed workers or multi-node scheduling. The first implementation should stay local and SQLite-backed.

This design does not remove backend cache behavior. It removes cache as a primary UI concept.

## Acceptance Criteria

The design is complete when the implementation can satisfy these conditions:

- A created job automatically prepares its upload package until review.
- The main UI contains no PTP cache permanence, roadmap, or planned-state language.
- `Advance phase` is absent from the main UI.
- `Start Upload` is the first action that can publish to PTP.
- Final upload media lives inside `data/jobs/<job-id>/media/upload`.
- Copying `data/jobs/<job-id>` is enough to restore the upload package without original downloads.
- A restored done job can automatically reseed through qBittorrent if qBittorrent lacks the torrent.
- Global logs and per-job logs are both available and readable.
- Automated tests do not contact real external systems.
