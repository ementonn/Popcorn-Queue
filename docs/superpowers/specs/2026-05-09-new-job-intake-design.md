# New Job Intake Design

## Goal

Add a first-class `New Job` page for manual uploads. The page creates an upload job from a media file that already exists on the server plus a source torrent supplied either as a local browser upload or a torrent download URL. The user must explicitly confirm the target PTP movie group before the job can be created for upload preparation.

This flow is for manual server-side media uploads. It does not require a source tracker site or source tracker URL. The PTP target replaces that requirement.

## User Flow

The left navigation gets a `New Job` item at the same level as `Jobs` and `Diagnostics`.

The page has four sections:

1. `Media`
   The user enters a server-side movie file path, such as `/home/emt/data/Movie.2024.1080p.WEB-DL.mkv`. The first version accepts typed paths for video files only. A later version can add a server file browser. The page provides a `Validate path` action that checks the path through the API.

2. `Source Torrent`
   The user provides the source torrent by either uploading a `.torrent` file from the browser or entering a torrent download URL. Only one source is active at a time. The saved job preserves the original torrent filename when it is known; otherwise it records the URL and stores the downloaded torrent as the internal source torrent file.

3. `PTP Target`
   After a media path or release name is available, the user clicks `Search PTP Movie`. The backend parses the release-style filename into a search name and year, calls the existing PTP API client, and returns movie group candidates. Each candidate is shown as a clickable movie title link pointing at `https://passthepopcorn.me/torrents.php?id=<groupId>`, for example `Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]`. The user must click `Confirm` on one result. Even a single high-confidence result requires confirmation.

4. `Release`
   The release name defaults from the media path or torrent filename and remains editable. It is used for parsing, review draft generation, and the final PTP form defaults.

After confirmation, `Create Job` creates the job, enqueues preparation, and takes the user back to `Jobs` with the new job selected. The workflow then continues as it does today: preparation runs automatically, the review drawer shows description, screenshots, MediaInfo-derived content, and PTP fields, and the user clicks `Upload` from review.

## Backend API Design

Add focused API endpoints rather than overloading the existing browser bridge route:

`POST /api/intake/media-path/validate`

Input: `{ "mediaPath": "/absolute/server/path" }`

Output includes whether the path exists, whether it is readable, whether it is an allowed video file, file size when available, and a normalized display basename. Validation does not mutate state. The path must be absolute and must live under a configured media root. Tests should configure this root with a temporary directory; a real deployment can configure `/home/emt/data`.

`POST /api/intake/ptp-search`

Input: `{ "title": "Release.Name.1976.1080p...", "mediaPath": "/optional/path" }`

The backend derives a candidate title from `title` first, then the media path basename. It uses the existing `parseTorrentTitle` and `PtpClient.searchByCandidate` path. Output is a compact list of candidates with `groupId`, `displayTitle`, `year`, `imdbId`, `ptpUrl`, and enough raw movie fields to build the draft after confirmation. This endpoint does not create a job.

`POST /api/intake/jobs`

This endpoint accepts multipart form data because it may contain a `.torrent` upload. Fields include `mediaPath`, `releaseName`, `ptpTarget`, and either uploaded file `torrent` or `torrentUrl`. `ptpTarget` contains the confirmed `groupId`, display title, PTP URL, and optional IMDb ID from the search result.

The endpoint validates the media path again, resolves the torrent source, creates the job workspace, saves the source torrent under the existing source torrent location, records source metadata, creates the job with a candidate that includes the confirmed PTP target, attaches the workspace, and enqueues preparation.

Torrent URL downloads are limited to HTTP and HTTPS. Local filesystem paths are only accepted for the media path, not for torrent URL.

## Job Model and Draft Behavior

Manual intake jobs use `source.site = "unknown"` and do not store a source tracker URL. The selected PTP target becomes the authoritative movie group.

The job should preserve:

- server media path as the original media input
- source torrent filename or torrent URL
- confirmed PTP group ID and PTP group URL
- PTP display title and year
- IMDb ID if returned by PTP

`reviewDraft.groupId` is prefilled from the confirmed PTP target. `reviewDraft.imdb`, title, and year use the confirmed PTP result when available. Upload submits to `upload.php?groupid=<groupId>`.

Preparation should treat the server media path as already available media. It should not wait for qBittorrent download completion for this manual intake path. Existing analysis, remux, screenshot, MediaInfo, torrent creation, review, upload, and qB reseed behavior should remain intact after the media input is resolved.

## Frontend Design

The new page follows the existing light Popcorn Queue interface rather than adding a marketing-style page. It should be a dense operational form with clear progress states:

- `Media path` input with validation status
- torrent source segmented control: `Upload file` or `Torrent URL`
- release name input
- `Search PTP Movie` button
- candidate result list with clickable PTP movie title links and `Confirm` buttons
- selected target summary with the confirmed movie title link
- `Create Job` button enabled only when media path is valid, a torrent source is present, and a PTP target is confirmed

Errors are shown near the relevant section and also surfaced through the existing status banner pattern. The page should not display internal implementation states such as cache policy or planned feature labels.

## Error Handling

Media path validation errors should distinguish missing path, relative path, path outside configured media roots, unreadable path, unsupported path type, and unsupported file extension.

PTP search errors should distinguish missing PTP API credentials, rate limit, PTP unavailable/intermission, no results, and unexpected API response. Search failures do not create jobs.

Torrent errors should distinguish missing torrent source, invalid upload, unsupported URL scheme, URL download failure, and downloaded content that is not a usable torrent. The implementation should avoid connecting tests to real trackers or PTP.

If the PTP target is not confirmed, job creation is blocked in the UI and rejected by the API.

## Testing

API tests cover media path validation, PTP search with a mocked PTP client, job creation with uploaded `.torrent`, job creation with mocked torrent URL download, and rejection paths for missing target, missing media file, and missing torrent source.

Worker/preparation tests cover that a manual intake job with a server media path uses that file directly and does not wait for qB download before analysis.

Frontend unit or Playwright tests cover navigation to `New Job`, validation flow, mocked PTP search result rendering, clickable PTP group link rendering, target confirmation, create-job submission, and redirect/selection of the created job.

All tests use local fixtures and mocked network clients. They must not submit to real PTP, download from real trackers, or require qBittorrent.
