# Configuration

Popcorn Queue loads `.env` from the repository root. When running commands from
`apps/api`, it also checks `../../.env`. Start from `.env.example`, then keep
real values only in local `.env`.

Use `npm run configure` for the core interactive setup. Use the Web settings
page for hot-editable integration values that the API can reload without process
restart. Infrastructure values such as ports, auth cookie settings, database
path, and data root should stay in `.env`.

## Local Service

| Key | Default | Purpose |
| --- | --- | --- |
| `POPCORN_QUEUE_HOST` | `0.0.0.0` | API bind host. |
| `POPCORN_QUEUE_PORT` | `3500` | API port. |
| `POPCORN_QUEUE_WEB_PORT` | `5173` | Web UI port. |
| `POPCORN_QUEUE_PUBLIC_SCHEME` | `http` | Scheme used when generating public API/Web URLs. |
| `POPCORN_QUEUE_PUBLIC_HOST` | `localhost` | Browser-visible host or IP. |
| `POPCORN_QUEUE_BROWSER_TOKEN` | `change-me` | Bearer token shared with the userscript. |
| `POPCORN_QUEUE_WEB_AUTH` | derived from PTP login | Enables Web login. |
| `POPCORN_QUEUE_WEB_AUTH_COOKIE` | `popcorn_session` | Web auth cookie name. |
| `POPCORN_QUEUE_WEB_AUTH_MAX_AGE_SECONDS` | `604800` | Web session lifetime. |

When using the userscript from another machine, set `POPCORN_QUEUE_HOST=0.0.0.0`
and `POPCORN_QUEUE_PUBLIC_HOST` to the host/IP opened in the browser, then rerun
`npm run userscript:local`.

## Persistence And Paths

| Key | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `file:./popcorn-queue.db` | Prisma SQLite database URL. |
| `POPCORN_QUEUE_DATA_ROOT` | `./data` | Durable job root. |
| `POPCORN_QUEUE_WORK_DIR` | `./data/work` | Worker scratch path. |
| `POPCORN_QUEUE_OUTPUT_DIR` | `./data/output` | Worker output path. |

Do not put `DATABASE_URL` or data-root settings in the Web settings page. They
change process-level storage behavior and require a controlled restart.

## Logs

| Key | Default | Purpose |
| --- | --- | --- |
| `POPCORN_QUEUE_LOG_LEVEL` | `info` | API and worker log level. |
| `POPCORN_QUEUE_LOG_TO_FILE` | `true` | Write JSON logs to files. |
| `POPCORN_QUEUE_LOG_TO_CONSOLE` | `true` | Also write logs to stdout/stderr. |
| `POPCORN_QUEUE_LOG_FILE` | `logs/api.log` | API log file. |
| `POPCORN_QUEUE_WORKER_LOG_FILE` | `logs/worker.log` | Worker/global phase log file. |

Per-job logs are written under `data/jobs/<jobId>/logs/job.log`.

## PTP

| Key | Default | Purpose |
| --- | --- | --- |
| `PTP_API_USER` | empty | PTP API duplicate-check user. |
| `PTP_API_KEY` | empty | PTP API duplicate-check key. |
| `PTP_USERNAME` | empty | PTP web login username. |
| `PTP_PASSWORD` | empty | PTP web login password. |
| `PTP_BASE_URL` | `https://passthepopcorn.me/torrents.php` | PTP torrents endpoint. |
| `PTP_USER_AGENT` | `Popcorn Queue/0.1` | API request user agent. |
| `PTP_REQUEST_DELAY_MS` | `2000` | Delay between PTP API requests. |
| `PTP_ANNOUNCE_URL` | empty | Announce URL used to create upload torrents and derive passkey. |
| `PTP_COOKIE_FILE` | `./data/ptp-cookies.txt` | Reusable PTP web session cookie. |

Run `npm run ptp:login` after setting `PTP_USERNAME`, `PTP_PASSWORD`, and
`PTP_ANNOUNCE_URL`.

## Optional Integrations

| Key | Default | Purpose |
| --- | --- | --- |
| `POPCORN_QUEUE_IMAGE_HOST` | `imgbb` | Primary image host. |
| `IMGBB_API_KEY` | empty | ImgBB uploads. |
| `PTPIMG_API_KEY` | empty | PTPImg uploads. |
| `TMDB_API_KEY` | empty | Metadata provider key when live metadata clients are enabled. |
| `QBITTORRENT_URL` | empty | qBittorrent Web API URL. |
| `QBITTORRENT_USERNAME` | empty | qBittorrent username. |
| `QBITTORRENT_PASSWORD` | empty | qBittorrent password. |
| `QBITTORRENT_TAGS` | `ptp,upload` | Tags applied to qBittorrent torrents. |
| `QBITTORRENT_CATEGORY` | empty | Optional qBittorrent category. |
| `QBITTORRENT_CONTENT_LAYOUT` | `Original` | qBittorrent content layout. |
| `QBITTORRENT_DOWNLOAD_WAIT_MS` | `21600000` | Max wait for source download. |
| `QBITTORRENT_DOWNLOAD_POLL_MS` | `15000` | qBittorrent polling interval. |

## Worker Tools

| Key | Default | Purpose |
| --- | --- | --- |
| `POPCORN_QUEUE_RUN_EXTERNAL_TOOLS` | `true` | Enables real worker binaries. |
| `FFMPEG_BIN` | `ffmpeg` | ffmpeg command. |
| `MEDIAINFO_BIN` | `mediainfo` | MediaInfo command. |
| `MKVMERGE_BIN` | `mkvmerge` | mkvmerge command. |
| `MPV_BIN` | `mpv` | mpv command used for Dolby Vision screenshot fallback. |
| `OXIPNG_BIN` | `oxipng` | PNG optimizer command. |
| `XVFB_RUN_BIN` | `xvfb-run` | Headless wrapper for mpv screenshots. |

Set `POPCORN_QUEUE_RUN_EXTERNAL_TOOLS=false` only for dry runs. Real upload
preparation expects the binaries to exist and be executable.

## Maintained Caches

`npm run scene-groups:update` refreshes the committed known scene-group cache
from Predb. Runtime scene detection does not query Predb per job; a release
group is scene only when it appears in the committed cache.
