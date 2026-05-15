# Integrations

Popcorn Queue is designed so tests run against mocks. Real integrations are
only used when configured locally.

## PTP API

`PTP_API_USER` and `PTP_API_KEY` are used by the backend duplicate checker. The
userscript never receives these values.

`PTP_REQUEST_DELAY_MS` controls backend request spacing. Keep it conservative
for manual runs.

## PTP Web Upload

`PTP_USERNAME`, `PTP_PASSWORD`, `PTP_ANNOUNCE_URL`, and `PTP_COOKIE_FILE` enable
real upload submit. Run:

```bash
npm run ptp:login
```

The login command validates credentials, prompts for 2FA when required, and
writes a reusable cookie file.

## qBittorrent

qBittorrent is used for source download and post-upload seeding.

Required settings:

- `QBITTORRENT_URL`
- `QBITTORRENT_USERNAME`
- `QBITTORRENT_PASSWORD`

Optional behavior:

- `QBITTORRENT_TAGS`: comma-separated tags applied to torrents.
- `QBITTORRENT_CATEGORY`: optional category.
- `QBITTORRENT_CONTENT_LAYOUT`: qB content layout, usually `Original`.
- `QBITTORRENT_DOWNLOAD_WAIT_MS`: maximum wait for source download completion.
- `QBITTORRENT_DOWNLOAD_POLL_MS`: polling interval.

If qB blocks re-adding a torrent because the hash already exists, the existing
qB download can still be used as the source when the job can identify the
downloaded media path.

## Image Hosts

Set `POPCORN_QUEUE_IMAGE_HOST` to the preferred host. Current supported keys:

- `IMGBB_API_KEY`
- `PTPIMG_API_KEY`

Image upload attempts are captured in phase output. Hosted screenshot URLs are
then used in the generated release description and review draft.

## Worker Tools

Worker tool commands are configurable:

- `FFMPEG_BIN`
- `MEDIAINFO_BIN`
- `MKVMERGE_BIN`
- `MPV_BIN`
- `OXIPNG_BIN`
- `XVFB_RUN_BIN`

Media preparation uses `mkvmerge` for remuxing. Screenshots normally use ffmpeg;
Dolby Vision screenshots use mpv with GPU/libplacebo rendering through the
configured mpv command. `xvfb-run` is used when headless rendering needs a
display wrapper.

The worker checks tool availability and records command output in phase
artifacts. Missing required tools should block at preflight instead of producing
a misleading upload package.

## Scene Group Cache

Runtime scene detection checks only the committed known-group cache:

```bash
npm run scene-groups:update
```

Groups not in the cache are treated as non-scene. The worker does not query
Predb for each job.
