# Popcorn Queue

Popcorn Queue is a TypeScript upload-preparation queue for PassThePopcorn workflows. It combines a browser bridge, duplicate checking, upload draft generation, screenshot and MediaInfo review, qBittorrent handoff, and a compact operator UI.

The project is designed so automated tests run against mocks. Real PTP, image hosts, qBittorrent, ffmpeg, MediaInfo, mkvmerge, and tracker services are only used when you explicitly configure them for manual testing.

![Popcorn Queue social preview](docs/assets/social-preview.png)

## Screenshots

![Queue dashboard](docs/assets/screenshot-dashboard.png)

![Job review drawer](docs/assets/screenshot-job-review.png)

![Diagnostics](docs/assets/screenshot-diagnostics.png)

## Features

- Browser bridge endpoint for source-site handoff
- Manual job creation from a server media path or source torrent
- PTP movie target search and manual PTP/IMDb target confirmation
- Permanent API-side duplicate-check cache
- Automated prepare-to-review pipeline
- MediaInfo, screenshots, release draft, edition fields, subtitles, and trumpable review
- Explicit upload action before PTP submission
- qBittorrent progress and post-upload seeding handoff
- Global diagnostics for API, PTP, image host, qBittorrent, and local media tools
- File and job logs for operator visibility

## Repository Layout

- `apps/api` exposes the browser bridge API, job API, diagnostics, logs, and upload endpoints.
- `apps/web` is the light, QUI-style operator interface.
- `apps/worker` runs upload preparation phases.
- `apps/userscript/popcorn-queue-bridge.user.js` is the browser-side bridge userscript.
- `packages/core` contains shared types, release parsing, cache keys, and upload planning.
- `packages/integrations` contains PTP, image host, and qBittorrent integration clients.
- `docs` contains architecture, API, browser bridge, migration, and manual testing notes.

## Quick Start

```bash
npm install
cp .env.example .env
npm test
npm run typecheck
npm run test:e2e -- --project=chromium-desktop
npm run dev:api
npm run dev:web
```

The default development ports are:

- API: `http://127.0.0.1:3500`
- Web UI: `http://127.0.0.1:5173`

For remote development, set `POPCORN_QUEUE_HOST=0.0.0.0` and update `POPCORN_QUEUE_API_URL`, `POPCORN_QUEUE_WEB_URL`, `VITE_API_BASE_URL`, and `POPCORN_QUEUE_ALLOWED_ORIGINS` for your host.

## Configuration

Start from `.env.example`. Keep your real `.env` local; it is ignored by Git.

Important settings:

- `POPCORN_QUEUE_BROWSER_TOKEN`: shared token for browser bridge requests
- `PTP_API_USER` and `PTP_API_KEY`: PTP API duplicate-check credentials
- `PTP_USERNAME`, `PTP_PASSWORD`, and `PTP_COOKIE_FILE`: manual PTP upload login support
- `PTP_ANNOUNCE_URL`: announce URL used when creating upload torrents
- `IMGBB_API_KEY` or `PTPIMG_API_KEY`: optional image hosting
- `QBITTORRENT_URL`, `QBITTORRENT_USERNAME`, `QBITTORRENT_PASSWORD`: qBittorrent integration
- `POPCORN_QUEUE_RUN_EXTERNAL_TOOLS`: enables ffmpeg, MediaInfo, mkvmerge, and oxipng execution

Automated tests do not require any of these real values.

## Browser Bridge

Install `apps/userscript/popcorn-queue-bridge.user.js` in a userscript manager such as Tampermonkey. Use the userscript menu to configure the API URL, web URL, and browser token from your local `.env`.

The browser bridge can send source-site candidates and torrent files to the API. The web UI then prepares jobs for review.

## Running the App

Run the API and web UI in separate shells:

```bash
npm run dev:api
npm run dev:web
```

Open the web UI, create or receive a job, review the upload draft, then press `Upload` when ready. The UI shows pending upload feedback while the API waits for PTP.

## Logs

```bash
npm run logs:api
npm run logs:worker
npm run logs:job -- <jobId>
```

Runtime logs are written under `logs/` and job logs under `data/jobs/<jobId>/logs/`. These paths are ignored by Git.

## Tests

```bash
npm test
npm run typecheck
npm run test:e2e -- --project=chromium-desktop
npm run audit:public
```

The test suite uses mocked external systems. Do not wire tests to real PTP, qBittorrent, image hosts, or trackers.

## Screenshots and Social Preview

Screenshots are generated from mock data:

```bash
npm run screenshots
```

The generated files live under `docs/assets/` and are safe to commit.

## Safety Notes

Do not commit `.env`, cookies, tracker passkeys, announce URLs, `.torrent` files, downloaded media, local databases, or runtime logs. Run `npm run audit:public` before publishing.

## License

MIT
