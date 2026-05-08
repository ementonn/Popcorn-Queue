# qBittorrent Realtime Download Progress Design

## Context

Popcorn Queue already uses qBittorrent during the `download-or-locate` phase to add a source torrent, poll until the torrent is complete, list torrent files, select the main media file, and continue automatically toward the human review step. The current UI can show that qB is ready after preparation, but it does not show download progress while the worker is waiting for qB.

QUI uses a backend-owned qBittorrent client pool and sync manager. The frontend does not connect to qB directly. It polls QUI's API, and the API returns torrent fields such as `progress`, `eta`, `dlspeed`, `downloaded`, `amount_left`, seeds, peers, state, and cached freshness metadata. Popcorn Queue should borrow the backend-owned status model without becoming a full qB manager.

## Goals

Show qB download progress in the job-driven upload workflow. The queue table should show compact progress for each job, and the selected job panel should show detailed qB status. After qB download completes, the pipeline should keep moving automatically through media preparation, inspection, screenshots, preflight, and review. The user should only need to make the final manual decision before uploading to PTP.

The implementation must not make the frontend talk to qB directly. Tests must not connect to real qB, PTP, or image hosts.

## Non-Goals

This is not a full torrent management page. It will not add global torrent browsing, bulk qB actions, cross-instance qB sync, category/tag management, peer tables, or a QUI-style torrent details interface. Those can be considered later if Popcorn Queue needs a separate download manager view.

## Selected Approach

Use worker-written job download snapshots, surfaced through the existing API polling path.

The worker already polls qB while waiting for completion. Instead of only asking whether a torrent is complete, the worker will read a structured torrent status snapshot on each poll. The API layer will persist that snapshot on the job record and return it from `/api/jobs` and `/api/jobs/:id`. The frontend dashboard will keep using its existing API polling and render the latest `downloadStatus`.

This keeps qB credentials and cookies on the backend, keeps remote browser sessions simple, and records the last known state even if the page reloads or the API restarts.

## Data Model

Add an optional `downloadStatus` object to each job:

```ts
interface DownloadStatus {
  client: "qbittorrent" | "not-configured" | string;
  infoHash: string | null;
  state: string;
  progress: number | null;
  downloaded: number | null;
  size: number | null;
  amountLeft: number | null;
  downloadSpeed: number | null;
  uploadSpeed: number | null;
  eta: number | null;
  seeds: number | null;
  peers: number | null;
  savePath: string | null;
  contentPath: string | null;
  lastUpdatedAt: string;
  error: string | null;
}
```

`progress` is a number from `0` to `1` when known. `eta` is seconds when known. `state` should be qB's state string when qB returns one, with local fallback states such as `waiting`, `unavailable`, `missing`, `complete`, `blocked`, or `error`.

## Backend Design

`@popcorn-queue/integrations` will extend the torrent client contract with `getStatus(infoHash)`. The qB implementation will call `/api/v2/torrents/info?hashes=...` and parse qB fields into the shared download status shape. `isComplete(infoHash)` can reuse `getStatus(infoHash)` and treat `progress === 1` or an equivalent complete state as complete.

`@popcorn-queue/worker` will extend `TorrentDownloadClient` with the same status method. The `download-or-locate` wait loop will report every qB status snapshot through a callback provided by the phase context. The worker remains persistence-agnostic: it reports snapshots, and the API layer decides how to store them.

`apps/api/src/preparation.ts` will inject a `reportDownloadStatus(jobId, status)` callback into the phase context. The callback will update the job record and append readable job log entries. To avoid log spam, it will write logs only for first status, completion, error, qB state changes, and progress crossing a 5 percent boundary. The job record can update on every poll.

`JobRepository` and the SQLite persistence repository will persist `downloadStatus` in job JSON. `/api/jobs` and `/api/jobs/:id` will return it automatically. A debug endpoint `/api/jobs/:id/download-status` may be added if useful, but the primary UI path is the existing jobs response.

## Frontend Design

`QueueTable` will add a compact `Download` column:

- Before download starts, show an empty or quiet waiting state.
- While downloading, show a small progress bar plus text such as `42% - 8.4 MB/s - 12m`.
- For queued, stalled, checking, or metadata states, show the qB state plus percentage, such as `Queued - 12%`.
- After download completes but preparation is still running, show `Downloaded`.
- If qB is missing or source torrent evidence is missing, show `No qB` or `No torrent` only when it is relevant to the current job.
- For errors, show a short message such as `qB auth failed`; details remain in the job log.

`ReviewPanel` will add a `Download` section for the selected job. It will show info hash, qB state, progress, downloaded size, total size, speed, ETA, seeds, peers, save path, content path, last update time, and last error. This section explains how the source media is arriving without replacing the existing review focus on screenshots, MediaInfo, upload torrent, and release draft.

No UI should show internal development labels such as `planned`, `scaffold`, or implementation status.

## Error Handling

If qB is not configured, the worker keeps the current skipped or blocked behavior and writes `downloadStatus.state = "unavailable"` with a short reason.

If qB login fails, including HTTP 401, the status becomes `error`, the job log records the redacted error, and the job should not appear as endlessly queued.

If the torrent was added but cannot be found by hash, the status becomes `missing`. A retry can re-add the torrent or continue querying the same hash, depending on the existing add behavior.

Queued, stalled, metadata download, and checking states are not failures. They remain visible as live qB states.

If the wait timeout expires before completion, the worker preserves the last known status, marks the phase blocked, and leaves retry available.

After API restart, the UI shows the last persisted status. A later retry or preparation run resumes status updates.

## Testing

Unit tests for `@popcorn-queue/integrations` will mock `fetch` and verify qB status parsing, missing torrent behavior, completion detection, and 401 handling. These tests must not connect to a real qB instance.

Worker tests will use a fake torrent client that returns staged statuses such as 0 percent, 50 percent, and 100 percent. They will verify that the status callback is invoked, completion continues to `listFiles`, and timeout preserves the latest status.

API repository and persistence tests will verify that `downloadStatus` can be written, listed, fetched by job ID, and restored from SQLite-backed job JSON.

Preparation tests will use fake qB clients. They will verify that `/api/jobs/:id` returns progress snapshots and that job logs are throttled instead of writing a line for every poll.

Frontend tests will cover `QueueTable` rendering for waiting, downloading, queued, downloaded, missing qB, and error states. Playwright tests will mock the API response and confirm that the queue `Download` column and selected-job `Download` section render without external systems.

## Rollout

Implement this as an additive change. Existing jobs without `downloadStatus` should render normally. Existing qB download behavior should keep working, except the worker will publish richer status snapshots while it waits.

## Open Decisions

Use the existing dashboard polling path first. Server-sent events and a QUI-style global qB sync manager are intentionally deferred until the job-scoped polling path proves insufficient.
