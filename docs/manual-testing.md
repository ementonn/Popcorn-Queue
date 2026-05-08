# Manual Testing

## Service Setup

The root `.env` is loaded by the API and by Vite. For remote development, bind
both services to `0.0.0.0` and use the reachable host/IP in the public URLs.

```bash
npm install
npm run dev:api
npm run dev:web
```

The dev scripts already bind the Web UI to `0.0.0.0`; the API uses
`POPCORN_QUEUE_HOST=0.0.0.0`.

## Environment

Start from `.env.example` and fill local secrets in `.env`. Do not commit `.env`.

Required for the browser bridge:

- `POPCORN_QUEUE_BROWSER_TOKEN`
- `POPCORN_QUEUE_WEB_URL`
- `POPCORN_QUEUE_API_URL`
- `VITE_API_BASE_URL` or `VITE_POPCORN_QUEUE_API_URL`

Required for real PTP duplicate checks:

- `PTP_API_USER`
- `PTP_API_KEY`

Required for real PTP upload submit:

- `PTP_USERNAME`
- `PTP_PASSWORD`
- `PTP_ANNOUNCE_URL`
- `PTP_COOKIE_FILE` if you want to reuse a browser-authenticated session or avoid
  interactive 2FA. Automated tests never use these values.

Optional manual integrations:

- `IMGBB_API_KEY`
- `PTPIMG_API_KEY`
- `QBITTORRENT_URL`
- `QBITTORRENT_USERNAME`
- `QBITTORRENT_PASSWORD`
- `QBITTORRENT_DOWNLOAD_WAIT_MS`
- `QBITTORRENT_DOWNLOAD_POLL_MS`
- `TMDB_API_KEY`

Worker binaries are disabled by default with
`POPCORN_QUEUE_RUN_EXTERNAL_TOOLS=false`. Set it to `true` only when you want
manual runs to execute `ffmpeg`, `mediainfo`, and `oxipng`.

When qBittorrent is configured, `download-or-locate` adds the uploaded source
torrent to qB using `data/jobs/<jobId>/download` as the save path, waits up to
`QBITTORRENT_DOWNLOAD_WAIT_MS`, then locates the largest video file from the qB
file list. If the torrent is still downloading, the job remains in preparation
instead of moving to upload review.

## Browser Bridge

Install `apps/userscript/popcorn-queue-bridge.user.js` in Tampermonkey, then set
the API URL, Web URL, and browser token from `.env`.

Expected flow:

1. Open a supported tracker page.
2. Click the browser bridge check action.
3. Confirm the badge/result is returned by `/api/browser/check/batch`.
4. Send the source torrent and candidate data to `/api/browser/jobs`. The
   backend stores the bytes at `torrent/source.torrent` but keeps the source
   site's original torrent filename for display.
5. Open the Web UI and select the new job.

If you see `POST /api/browser/check/batch failed with HTTP 401: unauthorized`,
the userscript token does not match `POPCORN_QUEUE_BROWSER_TOKEN`.

## Pre-Upload Review Flow

Jobs should automatically prepare until review. Before pressing `Start Upload`,
inspect the Web UI sections in order:

1. Blockers
2. Warnings
3. Duplicate/PTP Result
4. Download
5. Screenshots
6. MediaInfo / BDInfo
7. Upload Draft
8. Torrent / qB Readiness
9. Recent Job Log

`Start Upload` submits to PTP only after you save any needed Upload Draft edits
and the job is `ready`. Without PTP submit credentials the upload phase fails
cleanly and keeps the draft/artifacts available for retry.

The main UI does not show phase-advance controls. Open Diagnostics only when you
need raw logs, phase state, or debug routes.

## Logs

Use these from the project root:

```bash
npm run logs:api
npm run logs:worker
npm run logs:job
npm run logs:job -- <jobId>
```

The API also exposes:

- `GET /api/logs/global`
- `GET /api/jobs/<jobId>/logs`

## Backups and Restores

Copy `data/jobs/<jobId>/` to back up one job. The original source is under
`download/`; the upload-ready copy/hardlink/remux is under `media/upload/`.

To restore, copy the folder back and call `/api/jobs/import` with its `jobPath`
and `manifest`. If the manifest says the job was already done, Popcorn Queue
marks it `needs_reseed` and can push the upload torrent back into qBittorrent
through `/api/jobs/<jobId>/reseed`.

## Verification

Automated tests do not connect to real external systems:

```bash
npm test
npm run typecheck
npm run test:e2e
```
