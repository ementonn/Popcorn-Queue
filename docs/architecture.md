# Architecture

Popcorn Queue splits browser checking, durable queue state, upload preparation,
and operator review into separate packages so the old PtpUploader threading
model is not copied forward.

## Boundaries

- Browser bridge: parses tracker pages, renders badges, downloads source
  torrents with the browser session, and sends jobs to the API.
- API: authenticates browser bridge requests, checks PTP through a rate-limited
  backend client, stores permanent PTP cache entries in SQLite, creates jobs,
  exposes logs, and starts preparation.
- Worker: runs restartable upload phases, prepares `media/upload`, writes
  per-job logs, and stops at review before any upload.
- Web: shows the queue, pre-upload review checklist, service health, and
  Diagnostics. Cache policy and development roadmap state are intentionally not
  main-interface concepts.
- Core: owns shared contracts such as upload phases, readiness calculation,
  workspace layout, log redaction, parsing, rules, and upload-plan generation.

## Durable Job Phases

The worker phase contract is:

`intake -> duplicate-check -> metadata -> download-or-locate -> prepare-media -> inspect-media -> screenshots -> image-host-upload -> torrent-create -> seed-prepare -> preflight -> review -> upload -> post-hook -> done`

Preparation should automatically run until `review`, then stop. The operator
reviews evidence and presses `Start Upload`; manual `advance` and `skip`
controls belong in Diagnostics only.

## Workspace Layout

Every job is rooted under `data/jobs/<jobId>` unless `POPCORN_QUEUE_DATA_ROOT`
points elsewhere.

```text
data/jobs/<jobId>/
  manifest.json
  download/
  media/
    upload/
    intermediates/
  torrent/
    source.torrent
    upload.torrent
  screenshots/
  logs/
    job.log
```

`download/` keeps the original qBittorrent download. `torrent/source.torrent`
keeps the uploaded source torrent, and `torrent/upload.torrent` is prepared for
the final upload package when the source torrent can be reused. `media/upload/`
contains the hardlinked, copied, or remuxed upload-ready media. Backups can copy
the whole job folder; restoring through `/api/jobs/import` recreates the queue
record, and done jobs are marked for qBittorrent reseeding if the client no
longer has them.

## Logs

There are three log surfaces:

- `logs/api.log`: API service JSON lines.
- `logs/worker.log`: worker/global preparation JSON lines.
- `data/jobs/<jobId>/logs/job.log`: per-job events and phase output.

Sensitive keys, tokens, passwords, cookies, and announce URLs are redacted before
log lines are written.

## Cache Policy

PTP lookup cache lives in the backend, not the userscript. Entries are permanent
until a manual recheck refreshes them or a user invalidates the key. Backend
caching keeps PTP API credentials out of the browser and makes rate limiting
global.
