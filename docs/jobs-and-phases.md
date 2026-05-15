# Jobs And Phases

A job is the durable unit of work. It combines the source candidate, PTP lookup
result, review draft, phase outputs, logs, and file artifacts under one job ID.

## Phase Order

The phase contract is:

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
upload
sync-ptp-cache
post-hook
done
```

Preparation normally runs from `intake` to `review`, then stops for human
review. Upload phases run only after the operator presses `Start Upload`.

## Preparation Phases

| Phase | Purpose |
| --- | --- |
| `intake` | Build the upload plan from candidate data and current artifacts. |
| `duplicate-check` | Carry PTP duplicate result and review gates into the job. |
| `metadata` | Produce provider plans and metadata review gates. |
| `download-or-locate` | Use qBittorrent, source torrent, server path, or existing download path to locate media. |
| `prepare-media` | Hardlink, copy, or remux into `media/upload`. |
| `inspect-media` | Run MediaInfo and detect media features. |
| `screenshots` | Capture raw screenshots, optimize PNGs, and collect upload attempts. |
| `image-host-upload` | Store hosted image results from screenshot upload attempts. |
| `torrent-create` | Reuse or create upload torrent artifacts. |
| `seed-prepare` | Check whether upload torrent/media can be seeded. |
| `preflight` | Block on missing review requirements, tools, screenshots, or open gates. |
| `review` | Marks the job ready for operator review. |

## Upload Phases

| Phase | Purpose |
| --- | --- |
| `upload` | Submit the reviewed draft and upload torrent to PTP. |
| `sync-ptp-cache` | Add the new upload to the local PTP cache before post-upload work. |
| `post-hook` | Hand the upload torrent to qBittorrent for seeding. |
| `done` | Mark the worker run complete. |

If `post-hook` fails after a successful PTP upload, the job can remain in a
reseed-needed state instead of pretending the seed handoff succeeded.

## Artifacts

Each job lives under `data/jobs/<jobId>` unless `POPCORN_QUEUE_DATA_ROOT` is
changed.

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
    raw/
    optimized/
  logs/
    job.log
```

Important artifacts:

- `download/`: original qBittorrent download location.
- `media/upload/`: upload-ready media file.
- `torrent/source.torrent`: source-site torrent sent by the browser bridge or
  manual intake.
- `torrent/upload.torrent`: final torrent used for PTP upload.
- `screenshots/raw/`: local screenshots before hosting.
- `logs/job.log`: per-job JSON log lines.

## Retry Behavior

Failed preparation jobs can retry from the failed phase. Some completed phases
can be retried from the UI/API when downstream artifacts need to be regenerated.
For example, retrying screenshots should also refresh hosted image results and
preflight state.

Use phase retry when an artifact is stale. Use whole-job retry when preparation
failed before review.
