# Popcorn Queue Bridge

`apps/userscript/popcorn-queue-bridge.user.js` is the replacement name for the
old `ptp_checker.js` workflow.

## Responsibilities

- Detect supported sites: TJUPT, PTer, M-Team, HDBits, HHClub.
- Parse torrent title, IMDb ID, resolution, source page URL, and download URL.
- Submit candidates to `POST /api/browser/check/batch` in small chunks so long
  tracker pages show progressive badge updates instead of waiting for one large
  PTP batch to finish.
- Render PTP status badges and an `Up` action.
- Offer a manual `Recheck` action that sends `bypassCache: true` for the current page.
- Download the source torrent through the browser session.
- Preserve the source site's torrent filename from `Content-Disposition` when it
  is available, falling back to `<site>-<id>.torrent`.
- Create a Popcorn Queue job through `POST /api/browser/jobs`.
- Poll `GET /api/jobs/:id` after upload handoff and link the badge to the web job.

## Non-Responsibilities

- It does not store PTP API keys.
- It does not call PTP directly.
- It does not own the permanent PTP response cache.
- It does not decide coexisting rules locally.

## Setup

Run `npm run userscript:local`, then install
`apps/userscript/popcorn-queue-bridge.local.user.js` in Tampermonkey. The local
file is generated from `.env`, ignored by Git, and includes the concrete
`@connect` host for the configured API URL plus the supported source-site
download hosts.

After installing the generated userscript, use the Tampermonkey menu command to
set the browser token:

- `Set Browser Token`

The token must match `POPCORN_QUEUE_BROWSER_TOKEN` on the API service. To change
the API or web URL, update `.env`, rerun `npm run userscript:local`, and update
the installed Tampermonkey script.

## Usage

- `Check PTP` checks the visible torrent rows using the API cache.
- `Recheck` bypasses the saved PTP cache for the visible rows without deleting it.
- Right-click a rendered PTP badge to bypass the saved cache for that one
  torrent row.
- Click a PTP badge with a linked movie to open PTP.
- Click a queued job badge after pressing `Up` to open the Popcorn Queue job. The
  badge polls the job status and phase for several minutes after handoff.
