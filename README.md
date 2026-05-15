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
- `docs` contains architecture, API, configuration, operations, troubleshooting, and manual testing notes.

## Documentation

- [Documentation index](docs/README.md)
- [Configuration reference](docs/configuration.md)
- [Jobs and phases](docs/jobs-and-phases.md)
- [Integrations](docs/integrations.md)
- [Operations](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)
- [Security](docs/security.md)
- [Contributing](CONTRIBUTING.md)

## Quick Start and Configuration

```bash
npm install
npm run configure
npm run ptp:login
npm run dev:api
#start from a new shell
npm run dev:web
```

`npm run configure` writes `.env`, generates a browser token when one is not already set, enables local web login by default, and prompts only for the core PTP/qBittorrent values. Prompts are plain text so you can see what you type. `npm run ptp:login` validates PTP upload login, prompts for 2FA when PTP requires it, and saves a reusable cookie file.

The default development ports are:

- API: `http://127.0.0.1:3500`
- Web UI: `http://127.0.0.1:5173`

For remote development, set `POPCORN_QUEUE_HOST=0.0.0.0` and set `POPCORN_QUEUE_PUBLIC_HOST` to the hostname or IP you use in the browser. The API public URL, Web public URL, frontend API target, and CORS origins are derived from that host plus `POPCORN_QUEUE_PORT` and `POPCORN_QUEUE_WEB_PORT`.

Important settings:

- `POPCORN_QUEUE_BROWSER_TOKEN`: shared token for browser bridge requests
- `POPCORN_QUEUE_PUBLIC_HOST`: hostname or IP used to open the Web UI in a browser
- `POPCORN_QUEUE_PORT` and `POPCORN_QUEUE_WEB_PORT`: API and Web UI ports
- `POPCORN_QUEUE_WEB_AUTH`: requires the web UI to log in with `PTP_USERNAME` and `PTP_PASSWORD`
- `PTP_API_USER` and `PTP_API_KEY`: PTP API duplicate-check credentials
- `PTP_USERNAME`, `PTP_PASSWORD`, and `PTP_COOKIE_FILE`: manual PTP upload login support
- `PTP_ANNOUNCE_URL`: announce URL used when creating upload torrents
- `IMGBB_API_KEY` or `PTPIMG_API_KEY`: optional image hosting
- `QBITTORRENT_URL`, `QBITTORRENT_USERNAME`, `QBITTORRENT_PASSWORD`: qBittorrent integration
- `POPCORN_QUEUE_RUN_EXTERNAL_TOOLS`: enables ffmpeg, MediaInfo, mkvmerge, and oxipng execution

See [docs/configuration.md](docs/configuration.md) for the full environment
reference.

Keep your real `.env` local; it is ignored by Git.

## Browser Bridge

Run `npm run userscript:local`, then install
`apps/userscript/popcorn-queue-bridge.local.user.js` in a userscript manager
such as Tampermonkey. The generated local script is ignored by Git and contains
the API/Web URLs and userscript connection permissions derived from your local
`.env`. Use the userscript menu to set the browser token from
`POPCORN_QUEUE_BROWSER_TOKEN`. To change the API or Web URL later, update
`.env`, rerun `npm run userscript:local`, and update the installed userscript.

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

## Development Checks

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
