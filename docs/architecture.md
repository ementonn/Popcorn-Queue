# Architecture

Popcorn Queue splits browser checking, queue state, upload work, and UI into
separate packages so the old PtpUploader threading model is not copied forward.

## Boundaries

- Browser bridge: parses tracker pages, renders badges, downloads source torrents
  using the browser session, and sends data to the API.
- API: authenticates browser bridge requests, checks PTP through a rate-limited
  backend client, stores permanent PTP cache entries in SQLite, and creates jobs.
- Worker: runs durable upload phases and records phase-level events.
- Web: shows a dense queue, review workflow, health checks, logs, and settings.
- Upload plan: generates Upsies-inspired metadata, release-name, scene check,
  screenshot, torrent-reuse, MediaInfo/trumpable, and review-gate plans for
  every job before phase execution.

## Durable Job Phases

The worker phase contract is intentionally explicit:

`intake -> metadata -> duplicate-check -> download -> extract -> analyze -> screenshots -> torrent-create -> seed-start -> preflight -> upload -> post-hook -> done`

Each phase should persist status, start/end timestamps, retry count, and error
details. Retrying from a phase should reuse prior outputs only when the phase
contract says they are still valid.

The current API persists job snapshots in local SQLite through Prisma while
keeping the phase model explicit through `start`, `pause`, `retry`, `advance`,
plan refresh, and review-gate resolution endpoints. The storage adapter can move
to Postgres without changing the web contract.

## Cache Policy

PTP lookup cache lives in the backend, not the userscript. Entries are permanent
until a manual recheck refreshes them or a user invalidates the key. Backend
caching keeps PTP API credentials out of the browser and makes rate limiting
global.
