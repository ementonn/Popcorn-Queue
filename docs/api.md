# Browser API

All `/api/browser/*` routes require:

`Authorization: Bearer <POPCORN_QUEUE_BROWSER_TOKEN>`

## POST /api/browser/check/batch

Checks several tracker-page candidates against PTP.

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

The response includes normalized parsing, rule decision, PTP URL, cache hit/miss,
and cache age. Backend PTP cache entries are permanent until manually refreshed
or invalidated.

## POST /api/browser/jobs

Multipart form fields:

- `torrent`: source `.torrent` file.
- `candidate`: JSON serialized browser candidate.
- `checkResult`: JSON serialized result from `/api/browser/check/batch`.

The API creates a queued or review job and returns its ID.

## POST /api/browser/cache/invalidate

Deletes one backend PTP cache key derived from `{ title, imdbId }`.

## GET /api/jobs

Returns the current SQLite-backed upload queue. Each job includes:

- `uploadPlan.metadata`: IMDb/TMDb/TVmaze enrichment plan.
- `uploadPlan.releaseName`: normalized release-name output and warnings.
- `uploadPlan.scene`: predbnet/SRRDB verification plan.
- `uploadPlan.screenshots`: timestamp count, image host fallback, and tone-map hint.
- `uploadPlan.torrentReuse`: source torrent and piece-hash reuse strategy.
- `uploadPlan.media`: inferred container, disc type, audio/subtitle hints, and trumpable checks.
- `uploadPlan.reviewGates`: blocker/warning/info gates that must be resolved before upload.

## POST /api/jobs

Creates a manual upload job from JSON:

```json
{
  "site": "unknown",
  "title": "Movie.2024.1080p.BluRay.FLAC.x264-GROUP",
  "imdbId": "tt1234567",
  "sourceTorrentId": "optional-source-id"
}
```

## POST /api/jobs/:id/start

Starts a job unless blocker review gates are open.

## POST /api/jobs/:id/pause

Pauses the selected job.

## POST /api/jobs/:id/retry

Queues the current phase for retry and increments the phase retry count.

## POST /api/jobs/:id/advance

Marks the current phase complete and moves the job to the next phase.

## POST /api/jobs/:id/plan/refresh

Regenerates the Upsies-style upload plan while preserving already resolved review
gate status.

## POST /api/jobs/:id/review-gates/:gateId/resolve

Marks one review gate as resolved. URL-encode `gateId` because generated IDs can
contain `:`.

## GET /api/features

Returns the implemented/planned feature list surfaced by the web inspector.
