# Operations

Popcorn Queue is normally run as two long-lived processes: API and Web UI.

```bash
npm run dev:api
npm run dev:web
```

For a persistent deployment, wrap those commands with your process manager of
choice. Keep the same environment file and working directory for both services.

## Runtime Directories

- `data/`: database-adjacent job data, downloads, generated torrents,
  screenshots, and job logs.
- `logs/`: API and worker/global logs.
- `apps/userscript/popcorn-queue-bridge.local.user.js`: generated local
  userscript; reinstall it in the browser after host/token changes.

Back up `data/jobs/<jobId>` to preserve a job. Back up the SQLite database
configured by `DATABASE_URL` to preserve the queue state.

## Logs

```bash
npm run logs:api
npm run logs:worker
npm run logs:job -- <jobId>
```

API endpoints:

- `GET /api/logs/global`
- `GET /api/jobs/<jobId>/logs`

Log lines are JSON and should have secrets redacted before writing.

## Settings Changes

Use the Web settings page for hot-editable integration values such as PTP API
keys, image host keys, qBittorrent settings, and worker binary paths.

Restart the API when changing process-level values:

- ports and bind host
- public host/scheme
- web auth cookie settings
- database URL
- data root
- log file paths

After changing `POPCORN_QUEUE_PUBLIC_HOST`, ports, scheme, or browser token,
rerun `npm run userscript:local` and update the installed Tampermonkey script.

## Backup And Restore

For one job:

1. Copy `data/jobs/<jobId>/`.
2. Preserve its `manifest.json`.
3. Restore the folder under the same data root.
4. Use `/api/jobs/import` to recreate the queue record.

Done jobs restored from disk may need reseeding. Use the reseed action to hand
the upload torrent back to qBittorrent.

## Maintenance

Run these periodically:

```bash
npm run audit:public
npm run scene-groups:update
```

Review `data/jobs` and qBittorrent storage before deleting job data. The UI has
separate delete modes for removing only the queue record, only downloaded media,
or all related job data.
