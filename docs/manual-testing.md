# Manual Testing

## Service Setup

The root `.env` is loaded by the API and by Vite. On this server it is already
configured for:

- API: `http://example.com:3500`
- Web UI: `http://example.com:5173`
- Host binding: `0.0.0.0`
- Browser token: the migrated `POPCORN_QUEUE_BROWSER_TOKEN` value in `.env`

Run the services from the project root:

```bash
npm run dev:api
npm run dev:web
```

The API stores jobs and the permanent PTP cache in local SQLite via
`DATABASE_URL=file:./popcorn-queue.db`.

API logs are written as Pino JSON lines to `logs/api.log` and also printed to
the dev server console. To follow them while testing:

```bash
npm run logs:api
```

## Browser Bridge

Install `apps/userscript/popcorn-queue-bridge.user.js` in Tampermonkey, then set:

- Popcorn Queue API URL: `http://example.com:3500`
- Popcorn Queue Web URL: `http://example.com:5173`
- Browser Token: the `POPCORN_QUEUE_BROWSER_TOKEN` value from `.env`

The userscript sends duplicate checks to the API service and opens jobs in the
web UI. Right-clicking a status badge performs a fresh PTP recheck with the
permanent backend cache bypassed.

## External Systems

Automated tests do not connect to real external systems. API tests mock
persistence and PTP search calls; Playwright tests route API requests in the
browser; worker tests use injected command executors.

Manual PTP duplicate checks through the API still require `PTP_API_USER` and
`PTP_API_KEY` in `.env`. The migrated PTP username/password are kept separately
for future upload/login automation. Optional provider and upload integrations
are configured through:

- `TMDB_API_KEY`
- `IMGBB_API_KEY`
- `PTPIMG_API_KEY`
- `QBITTORRENT_URL`
- `QBITTORRENT_USERNAME`
- `QBITTORRENT_PASSWORD`

Worker binaries are also disabled by default with
`POPCORN_QUEUE_RUN_EXTERNAL_TOOLS=false`. Set it to `true` only when you want a
manual worker run to execute `ffmpeg`, `mediainfo`, and `oxipng`.

ImgBB is supported through `IMGBB_API_KEY`. Screenshot plans will prefer
`POPCORN_QUEUE_IMAGE_HOST=imgbb` when configured, and worker screenshot uploads
can use the ImgBB uploader when an image-host client is injected into a manual
worker run.
