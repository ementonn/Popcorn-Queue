# Troubleshooting

Start from the job drawer, then check logs:

```bash
npm run logs:api
npm run logs:worker
npm run logs:job -- <jobId>
```

## Browser Bridge Fails

Symptom: `Request failed: /api/browser/check/batch`.

Check:

- API is running on `POPCORN_QUEUE_PORT`.
- `POPCORN_QUEUE_PUBLIC_HOST` and `POPCORN_QUEUE_PUBLIC_SCHEME` match the URL
  the browser can reach.
- `POPCORN_QUEUE_BROWSER_TOKEN` matches the token set in Tampermonkey.
- The generated userscript has a matching `@connect` host. Rerun
  `npm run userscript:local` after host changes.
- Browser console and API logs for HTTP status. `401` means token mismatch.

## Job Does Not Appear In UI

Check:

- API accepted `POST /api/browser/jobs` or manual intake request.
- Web UI is pointed at the same API port.
- `GET /api/jobs` returns the job.
- API logs for persistence errors.
- Browser cache only after confirming API state.

## qBittorrent Download Is Blocked

If qBittorrent reports an existing torrent/hash, locate the existing download
from qB and use it as the source path when possible. Confirm the media path in
the job drawer before continuing.

Check:

- `QBITTORRENT_URL`, username, and password.
- qB category/tags do not hide the torrent from the configured view.
- The source torrent hash and stored download/seed hash in job artifacts.
- qB file list contains a complete video file.

## Screenshot Phase Fails

Check:

- `POPCORN_QUEUE_RUN_EXTERNAL_TOOLS=true`.
- `FFMPEG_BIN`, `MPV_BIN`, `OXIPNG_BIN`, and `XVFB_RUN_BIN` resolve.
- The prepared media file exists under `media/upload`.
- Dolby Vision sources use the mpv screenshot path.

Screenshot failure should stop the job instead of letting preflight proceed with
missing screenshots.

## Media Preparation Fails

Check:

- Source media path exists and is readable by the API/worker process.
- `MKVMERGE_BIN` is available for remuxing.
- Job logs include the exact external command and stderr.
- Disk space under `POPCORN_QUEUE_DATA_ROOT`.

The worker should use mkvmerge for Matroska remuxing. ffmpeg remux errors around
Dolby Vision tags usually indicate the wrong remux path.

## Description Or Screenshots Are Stale

Retry the relevant completed phase. Screenshots retry should refresh hosted
image output and preflight data. If a retry only changes local artifacts, check
that downstream dependent phases were also rerun.

## PTP Upload Fails

Check:

- `PTP_USERNAME`, `PTP_PASSWORD`, `PTP_ANNOUNCE_URL`, and `PTP_COOKIE_FILE`.
- `npm run ptp:login` succeeds and updates the cookie file.
- Review draft fields match PTP form options.
- Upload torrent path points to the final upload torrent.
- Job log for PTP submit error and whether the error is retryable.

## Public Audit Fails

Read the exact finding, remove the tracked secret or path, then rerun:

```bash
npm run audit:public
```

If the finding is in history, rotate the secret and rewrite history before
pushing public changes.
