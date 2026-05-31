# RSS Proposals Design

## Purpose

Add an RSS page that can subscribe to tracker RSS feeds, filter incoming
torrents, run duplicate checks, and present upload proposals. The feature must
not download torrents automatically. A torrent only enters the existing job
pipeline after the user accepts a proposal.

The first target feed is a NexusPHP/ZMPT-style torrent RSS feed. The design
should not bake in one tracker, but it can start with the fields visible in
that feed: RSS title, source details link, torrent download URL, size, GUID,
published date, and a description containing source metadata.

## Goals

- Add a dedicated RSS page to the Web UI.
- Let the user add, pause, edit, and delete RSS subscriptions.
- Let each subscription define its own filter rules.
- Use one global RSS update interval.
- Run duplicate checks before generating proposals.
- Keep the main proposal list clean by showing only actionable items.
- Keep an All Items view so filtered, skipped, duplicate, and failed items are
  still inspectable.
- Require user confirmation before downloading a torrent or creating a job.
- Reuse the existing job preparation pipeline after a proposal is accepted.

## Non-Goals

- No automatic download before user acceptance.
- No automatic upload to PTP.
- No attempt to derive a PTP target from the source tracker details page.
- No Douban-based target resolution in the first version.
- No full RSS description HTML storage in the database.
- No cross-subscription dedupe in the first version, except to avoid creating a
  duplicate job at accept time.

## Selected Approach

Use a separate RSS domain with its own persisted subscriptions and items.
Subscriptions and RSS items are not jobs. An RSS item becomes a job only after
the user accepts it.

This keeps the existing job state machine focused on execution work:
download, media inspection, screenshots, preflight, review, and upload. RSS is
a candidate/proposal layer in front of that pipeline.

The rejected alternatives were:

- Reusing the `Job` table for proposals. This would pollute the queue with
  unconfirmed RSS items and complicate preparation state handling.
- Keeping RSS items only in memory or pulling live on page load. This would lose
  duplicate-check results, filter reasons, ignored state, and refresh history.

## UI

Add `RSS` to the main sidebar.

The RSS page has:

- A left column with subscriptions.
- A global update interval control.
- A selected-subscription header with manual refresh and filter edit actions.
- A `Proposals` tab.
- An `All Items` tab.

The `Proposals` tab shows only actionable RSS items. Each row shows:

- release title;
- size;
- `Source` link to the tracker details page;
- duplicate-check badge using the existing PTP check status text;
- PTP target link when one was resolved;
- reason text from duplicate check or target resolution;
- `Accept` and `Ignore` actions.

The row should not show RSS GUIDs or internal item IDs. Those stay internal for
dedupe and debugging.

The `All Items` tab shows every processed RSS item for the selected
subscription. It includes the release title, `Source` link, RSS item status,
duplicate-check badge, reason, and related job link if accepted.

## Duplicate Badges

RSS proposals reuse `BrowserCheckService` and show the same decision status
used by PTP checks. The RSS UI does not invent a separate proposal status such
as `review`.

Actionable duplicate statuses:

- `open`
- `not_found`
- `no_torrents`
- `coexist`
- `trumpable`

Non-actionable statuses:

- `full`
- `skip`
- `error`

If core returns the rare internal `review` status, the RSS item is not promoted
to a proposal in the first version. Store it as `duplicate_skip`, show a `skip`
badge in All Items, and keep the original reason text for debugging.

## PTP Target Resolution

PTP target resolution comes from Popcorn Queue, not from the source tracker.

Resolution order:

1. IMDb ID if it is present in parsed RSS metadata.
2. Title/year lookup through the existing PTP client and duplicate-check flow.

Do not use Douban in the first version. Douban links may appear in source
description content, but they are not displayed as a badge and are not used for
target resolution.

When duplicate check returns a PTP movie, store a PTP target summary on the RSS
item and display it as a link:

- `groupId`
- `displayTitle`
- `year`
- `imdbId`
- `ptpUrl`
- `resolvedFrom`: `imdb` or `title_year`

If no PTP target is resolved, the row still appears in All Items. It becomes a
proposal only when the duplicate status is actionable under the mapping above.

## Persistence

Add RSS persistence beside the existing SQLite persistence.

`RssSettings`

- `id`
- `updateIntervalMs`
- `updatedAt`

There is one settings row. The default interval is conservative, such as ten
minutes, and can be changed from the RSS page without restarting the API.

`RssSubscription`

- `id`
- `name`
- `site`
- `feedUrl`
- `enabled`
- `filterJson`
- `lastFetchedAt`
- `lastRunStatus`
- `lastRunMessage`
- `createdAt`
- `updatedAt`

`feedUrl` is stored in full because the poller needs it. API responses and logs
must expose only a redacted display URL.

`RssItem`

- `id`
- `subscriptionId`
- `guid`
- `sourceUrl`
- `downloadUrl`
- `title`
- `subtitle`
- `size`
- `publishedAt`
- `status`
- `filterReason`
- `checkResultJson`
- `ptpTargetJson`
- `acceptedJobId`
- `lastError`
- `rawJson`
- `createdAt`
- `updatedAt`

`rawJson` stores a small parsed summary of useful RSS fields. It should not
store full HTML descriptions.

Suggested `RssItem.status` values:

- `proposal`
- `filtered`
- `duplicate_full`
- `duplicate_skip`
- `check_error`
- `ignored`
- `accepted`

`proposal` is not a separate table. It is an `RssItem` status.

## Subscription Filters

Each subscription owns its filter rules. There is no global filter in the first
version.

The first filter UI should be form-based:

- include keywords;
- exclude keywords;
- allowed resolutions;
- allowed codecs;
- allowed release groups;
- blocked release groups;
- minimum size;
- maximum size.

The API stores these as structured JSON. A filtered item is saved with
`status=filtered` and a human-readable `filterReason`. Filtered items do not
run duplicate checks.

## Refresh Flow

The API owns an RSS poller.

1. On API startup, create the RSS service and load enabled subscriptions.
2. At the global interval, refresh enabled subscriptions.
3. A subscription may have only one refresh running at a time.
4. Fetch the RSS XML.
5. Parse items into normalized RSS item candidates.
6. Dedupe within the subscription.
7. Apply the subscription filter.
8. Run duplicate check for items that pass the filter.
9. Save each item with its final RSS status.
10. Record subscription last-run status and message.

Manual refresh uses the same flow and should respect the same per-subscription
single-run guard.

## Dedupe

Within a subscription, dedupe in this order:

1. RSS GUID;
2. source details URL;
3. release title plus published date.

If an item was ignored or accepted, future refreshes must not recreate it as a
proposal.

Across subscriptions, do not try to merge RSS items in the first version. At
accept time, check for an existing accepted item or job with the same source URL
or download URL before creating a duplicate job.

## Accept Flow

Accepting a proposal is the only path that downloads the torrent.

1. User clicks `Accept`.
2. API verifies the item exists and has `status=proposal`.
3. API checks that the same source/download URL has not already been accepted.
4. API downloads the torrent from `downloadUrl`.
5. API creates a normal job through the existing intake/job creation path.
6. API writes source, candidate, duplicate check result, PTP target, and torrent
   metadata into the job workspace.
7. API calls `enqueuePreparation(job.id)`.
8. RSS item becomes `accepted` and stores `acceptedJobId`.
9. UI offers a link to the created job.

If torrent download or job creation fails, the RSS item remains a proposal and
stores `lastError` so the user can retry.

## Ignore Flow

Ignoring a proposal sets `status=ignored`. The item remains visible in All
Items. Future refreshes that see the same GUID/source URL must not recreate it
as a proposal.

## API Surface

Add routes under a new RSS route module:

- `GET /api/rss/settings`
- `PATCH /api/rss/settings`
- `GET /api/rss/subscriptions`
- `POST /api/rss/subscriptions`
- `PATCH /api/rss/subscriptions/:id`
- `DELETE /api/rss/subscriptions/:id`
- `POST /api/rss/subscriptions/:id/refresh`
- `GET /api/rss/subscriptions/:id/items`
- `POST /api/rss/items/:id/accept`
- `POST /api/rss/items/:id/ignore`

The item list route supports a `view` or `status` filter so the UI can load
Proposals and All Items from the same data.

RSS routes should require the existing Web auth session. They are not browser
bridge routes and should not be exposed through the browser token.

## Security And Redaction

Feed URLs and torrent download URLs can contain secrets. They must not leak in
logs or normal UI display.

Extend redaction to cover URL query parameters such as:

- `passkey`
- `downhash`
- `auth`
- `token`
- `key`

The API may return a redacted display URL and a boolean indicating whether the
feed URL is configured. It should not return full feed URLs unless the route is
explicitly designed for editing and follows the same secret-field pattern as
the Settings page.

Job logs, global logs, source JSON, and RSS item summaries must avoid printing
full secret-bearing URLs. If a full URL must be stored for execution, do not
include it in log payloads.

## Error Handling

- RSS fetch failure updates the subscription last-run status and message.
- RSS parser failure marks the subscription refresh as failed.
- Duplicate-check failure saves the item as `check_error`.
- PTP rate limit errors should not block the API; they are stored on the item
  and shown in All Items.
- Accept failure leaves the item as `proposal` and stores `lastError`.
- A failed subscription refresh must not affect existing jobs.

## Testing

Implementation should include focused tests for:

- RSS parser extraction from a ZMPT/NexusPHP RSS item.
- URL redaction for feed URLs and torrent download URLs.
- Subscription filter behavior and filter reasons.
- Duplicate status mapping from `BrowserCheckService` results to RSS item
  statuses.
- Accept flow creating a job only after user confirmation.
- Dedupe by GUID and source URL.
- API routes for settings, subscriptions, refresh, item lists, accept, and
  ignore.
- Web UI rendering for subscriptions, global interval, Proposals, All Items,
  Source links, PTP target links, Accept, and Ignore.

## Implementation Notes

- Put RSS parsing and filtering in focused modules rather than in route files.
- Add a small RSS service that owns polling, manual refresh, and item
  classification.
- Keep the poller dependency-injected so tests can use fake fetch and fake
  duplicate-check services.
- Reuse existing `TorrentCandidate`, `BrowserCheckResult`, and job creation
  contracts where possible.
- Keep the RSS feature independent from the userscript/browser bridge.

## Success Criteria

- RSS subscriptions can be created and refreshed from the Web UI.
- The global interval can be changed without API restart.
- RSS refresh never downloads torrents automatically.
- Actionable items appear in Proposals with Source and PTP target links.
- Full, skipped, filtered, errored, ignored, and accepted items are visible in
  All Items.
- Accepting a proposal creates a job and starts the existing preparation
  pipeline.
- Secret-bearing RSS and torrent URLs are not exposed in logs or normal UI.
