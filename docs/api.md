# API

All `/api/browser/*` routes require:

`Authorization: Bearer <POPCORN_QUEUE_BROWSER_TOKEN>`

Automated tests mock external systems. Real PTP, image-host, qBittorrent, and
media-tool calls are only used when you run the service manually with the
matching `.env` values.

## Browser Bridge

### POST /api/browser/check/batch

Checks tracker-page candidates against PTP through the backend client and the
permanent SQLite cache.

```json
{
  "candidates": [
    {
      "site": "mteam",
      "title": "Movie.2024.1080p.WEB-DL.x265-GROUP",
      "imdbId": "tt1234567",
      "resolution": "1080p",
      "sourceUrl": "https://kp.m-team.cc/detail/123"
    }
  ]
}
```

The response includes normalized parsing, rule decision, PTP URL, and cache hit
metadata. Use `bypassCache: true` for an explicit fresh recheck.

### POST /api/browser/jobs

Multipart form fields:

- `torrent`: source `.torrent` file.
- `candidate`: JSON serialized browser candidate.
- `checkResult`: JSON serialized duplicate-check result.

The API creates a job, writes its workspace manifest, and queues automatic
preparation up to the review step.

The uploaded source torrent is saved to `data/jobs/<jobId>/torrent/source.torrent`
before preparation starts. The multipart filename is preserved separately as
`job.torrent.filename`, so the UI can show the original source-site torrent name
even though the internal path stays stable.

### POST /api/browser/cache/invalidate

Deletes one backend PTP cache key derived from `{ title, imdbId }`.

## Queue

### GET /api/jobs

Returns the current SQLite-backed upload queue. Jobs include `uploadReadiness`,
`humanStep`, `workspace`, `artifacts`, `reviewDraft`, `phases`, and
`uploadPlan.reviewGates`.

### POST /api/jobs

Creates a manual upload job from JSON:

```json
{
  "site": "unknown",
  "title": "Movie.2024.1080p.BluRay.FLAC.x264-GROUP",
  "imdbId": "tt1234567",
  "sourceTorrentId": "optional-source-id"
}
```

### POST /api/jobs/import

Imports a restored job workspace from `jobPath` and `manifest`. If the restored
manifest is already `done`, required upload media and upload torrent paths are
validated first. Valid done jobs are marked `needs_reseed` so qBittorrent can be
repopulated instead of silently assuming the client still has it. Missing files
put the job back in review with `missing_evidence`.

### PATCH /api/jobs/:id/review-draft

Patches the editable PTP upload draft. The draft is initialized from the upload
plan and worker artifacts when a job reaches review.

### POST /api/jobs/:id/start-upload

Starts upload only when `uploadReadiness` is `ready` and no blocker gate is open.
This is the normal operator action after reviewing screenshots, MediaInfo/BDInfo,
release draft, torrent path, and qB readiness.

With `PTP_USERNAME`, `PTP_PASSWORD`, `PTP_ANNOUNCE_URL`, and optional
`PTP_COOKIE_FILE` configured, the API runs the upload tail and submits the
prepared `torrent/upload.torrent` to PTP. Unit tests inject a fake submitter and
never connect to real PTP.

### POST /api/jobs/:id/pause

Pauses the selected job.

### POST /api/jobs/:id/retry-failed

Retries failed jobs or failed phases. It does not advance a healthy job.

### POST /api/jobs/:id/reseed

Adds the restored upload torrent to qBittorrent with the job's upload directory
as the save path. If qBittorrent is unavailable, the job remains `needs_reseed`.

### POST /api/jobs/:id/review-gates/:gateId/resolve

Marks one review gate as resolved. URL-encode `gateId` because generated IDs can
contain `:`.

## Logs

### GET /api/jobs/:id/logs

Returns the tail of `data/jobs/<jobId>/logs/job.log`.

### GET /api/logs/global

Returns tails from `logs/api.log` and `logs/worker.log`.

## Diagnostics-Only Debug Routes

These routes exist for recovery and local debugging. The main UI keeps them
inside Diagnostics.

- `POST /api/jobs/:id/debug/advance`
- `POST /api/jobs/:id/debug/skip`
- `POST /api/jobs/:id/debug/force-state`
