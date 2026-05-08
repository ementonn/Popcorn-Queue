# Popcorn Queue Bridge

`apps/userscript/popcorn-queue-bridge.user.js` is the replacement name for the
old `ptp_checker.js` workflow.

## Responsibilities

- Detect supported sites: TJUPT, PTer, M-Team, HDBits, HHClub.
- Parse torrent title, IMDb ID, resolution, source page URL, and download URL.
- Submit candidates to `POST /api/browser/check/batch`.
- Render PTP status badges and an `Up` action.
- Offer a manual `Recheck` action that sends `bypassCache: true` for the current page.
- Download the source torrent through the browser session.
- Create a Popcorn Queue job through `POST /api/browser/jobs`.
- Poll `GET /api/jobs/:id` after upload handoff and link the badge to the web job.

## Non-Responsibilities

- It does not store PTP API keys.
- It does not call PTP directly.
- It does not own the permanent PTP response cache.
- It does not decide coexisting rules locally.

## Setup

Install the userscript, then use the Tampermonkey menu commands:

- `Set Popcorn Queue API URL`
- `Set Popcorn Queue Web URL`
- `Set Browser Token`

`Set Popcorn Queue API URL` points to the API service. The web URL points to the
QUI-style frontend used for opening `/jobs/:id` links. The token must match
`POPCORN_QUEUE_BROWSER_TOKEN` on the API service.

## Usage

- `Check PTP` checks the visible torrent rows using the API cache.
- `Recheck` bypasses the saved PTP cache for the visible rows without deleting it.
- Right-click a rendered PTP badge to run the same bypass-cache recheck.
- Click a PTP badge with a linked movie to open PTP.
- Click a queued job badge after pressing `Up` to open the Popcorn Queue job. The
  badge polls the job status and phase for several minutes after handoff.
