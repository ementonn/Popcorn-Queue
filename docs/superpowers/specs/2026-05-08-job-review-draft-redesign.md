# Job Review Drawer, MediaInfo, and PTP Draft Redesign

Date: 2026-05-08

## Context

Popcorn Queue currently shows the selected job in a fixed third column. This makes the details panel too narrow and forces the table to give up horizontal space. The review draft form also only exposes a small set of loosely modeled fields, while the real PassThePopcorn upload page contains a larger and more structured form. MediaInfo is currently collected as JSON and then reused in the release description, but PTP expects a full human-readable MediaInfo or BDInfo log.

The old PtpUploader uses `mediainfo <file>` for the full text output, strips the upload root from `Complete name`, parses that text for selected fields, and builds release descriptions as MediaInfo or BDInfo followed by screenshot BBCode. The uploaded PTP HTML page confirms the real form fields and validation expectations: torrent file, type, IMDb/title/year/cover/trailer for new movies, edition/remaster metadata, source/codec/container/resolution select fields with `Other` companions, tags, synopsis, `release_desc`, subtitles, NFO, trumpable flags, upload token, preview, and submit.

## Goals

The redesign will make job review usable for real manual approval before upload. The job detail panel should be wide enough for MediaInfo, screenshots, draft fields, and logs without compressing the queue table. MediaInfo should be correct for PTP submission and still useful for internal parsing. The draft editor should reflect the actual PTP upload form closely enough that saved drafts can map directly to final submit payloads.

## Non-Goals

This spec does not change the visual theme away from the current light QUI-like style. It does not connect tests to real PTP, qBittorrent, IMDb, image hosts, or other external systems. It does not implement a full browser clone of the PTP upload page; it models the form in Popcorn Queue's own UI.

## Job Drawer Design

The app shell will change from three fixed columns to a sidebar plus a main table workspace. Selecting a job opens a right-side overlay drawer instead of reserving a permanent third column. The drawer uses `position: fixed`, covers the right side of the table, and does not resize the table layout.

The drawer default width is `min(860px, 72vw)`. It has a minimum width of 520px and a maximum width that leaves the sidebar and a small margin visible on desktop. A resize handle on the left edge allows manual width changes. The chosen width is stored in `localStorage` and reused on the next open. On small screens the drawer becomes full-screen.

The drawer header is sticky and contains the release name, state/readiness, primary actions, and close. The body is organized into compact sections or tabs: Review, Draft, Evidence, and Logs. Selecting a different row updates the open drawer content. Escape and the close button close the drawer.

## MediaInfo Data Contract

Worker media inspection will produce two MediaInfo artifacts:

`mediaInfoText` is the complete output of `mediainfo <file>`. It is used for frontend display, release description generation, and PTP submit content. It must remove absolute job paths from `Complete name`, replacing them with paths relative to the job upload root when possible.

`mediaInfoJson` is the output of `mediainfo --Output=JSON <file>`. It is used only for internal parsing: duration, codec, container, HDR, resolution, audio, and subtitle metadata.

For compatibility, `artifacts.mediainfo` will point to the text output. New code should prefer explicit `artifacts.mediaInfoText` and `artifacts.mediaInfoJson` names to avoid ambiguity.

Description generation will follow the PtpUploader shape: optional release title header, optional release notes when supported, full MediaInfo or BDInfo, then screenshot links as `[img=URL]` entries separated by blank lines. JSON MediaInfo must not be placed in `release_desc`.

## Readiness Rules

Upload readiness must require more than just a prepared media file. A job should be blocked from Start Upload when any of these are missing:

- Final upload media.
- Full text MediaInfo or BDInfo.
- At least three hosted PNG screenshot links.
- Upload torrent.
- Required PTP draft fields for the chosen add-format or new-movie mode.

MediaInfo text failure with JSON success leaves the job in review with a blocker for missing full MediaInfo text. JSON failure with text success leaves the job in review with a warning and uses fallback screenshot timestamps. Fewer than three screenshot links is a blocker.

## PTP Draft Model

The draft model will be expanded so it maps directly to the real PTP upload form. The UI may keep a friendly shape, but the saved data must preserve enough information to build the final POST without guessing.

Core draft fields:

- Torrent display fields: upload torrent path and source torrent filename.
- Existing group ID for add-format uploads.
- Type.
- Source, codec, container, and resolution.
- `other_source`, `other_codec`, `other_container`, and `other_resolution_width` / `other_resolution_height` when the selected value is `Other`.
- Remaster flag, remaster title, remaster year, and quick edition tags such as HDR10, HDR10+, Dolby Vision, 10-bit, and Remux.
- Release description.
- Subtitle selections.
- Trumpable selections.
- Scene, personal rip, internal, and special flags.
- NFO text.

Advanced PTP fields:

- IMDb, title, year, cover image, trailer.
- Artists and importance values when needed for new movies.
- Tags and synopsis.
- Upload token.

The submitter should submit direct select values when possible. It should only use `Other` plus `other_*` fields when the selected value is not a known PTP option. This is closer to the real PTP upload page and allows better validation than always forcing `Other`.

## Draft UI Design

The Draft tab is split into Core and Advanced PTP sections. Core is visible by default and contains the fields most likely to need manual review before upload. Advanced PTP is collapsed by default and contains new-movie metadata and less common fields.

Core fields use selects, checkboxes, and compact grouped controls instead of free-form text wherever the real PTP form has constrained options. Release Description and NFO are large text areas. MediaInfo and screenshot evidence are shown near the fields that depend on them so the user can verify the final submission before pressing Start Upload.

The UI should show missing required draft fields inline and at the drawer header. Saving the draft updates the job immediately and keeps the drawer open.

## PTP Submit Mapping

Add-format uploads post to `/upload.php?groupid=<id>` and include the `groupid` form field. New-movie uploads post to `/upload.php` and include IMDb/title/year/cover/trailer/artists/tags/synopsis fields.

Common form keys include:

- `type`
- `remaster`, `remaster_year`, `remaster_title`
- `source`, `other_source`
- `codec`, `other_codec`
- `container`, `other_container`
- `resolution`, `other_resolution_width`, `other_resolution_height`
- `release_desc`
- `nfo_text`
- `AntiCsrfToken`
- `subtitles[]`
- `trumpable[]`
- `scene`
- `internalrip`
- `special`
- `uploadtoken`
- `file_input`

Tests must verify FormData keys against mocked fetch calls only. They must not submit to real PTP.

## Testing Plan

Core tests will cover draft normalization, PTP select versus Other mapping, required field validation, and release description generation.

Worker tests will cover MediaInfo text and JSON collection, absolute path stripping in MediaInfo text, JSON parsing from the JSON artifact, and readiness behavior when MediaInfo or screenshots are incomplete.

Integration tests will mock `fetch` and verify PTP FormData for add-format and new-movie uploads. They will check `release_desc`, `nfo_text`, `subtitles[]`, `trumpable[]`, remaster fields, scene/internal/special flags, upload token, and torrent file attachment.

Frontend tests will cover opening the job drawer, resizing it, persisting width in localStorage, closing it, switching selected jobs, editing Core draft fields, expanding Advanced PTP, saving drafts, and showing blockers for missing evidence.

## Migration and Compatibility

Existing jobs with JSON in `artifacts.mediainfo` should not crash the UI. The frontend should detect JSON-like MediaInfo and label it as legacy/internal until the job is regenerated. New jobs should write text to `artifacts.mediainfo` and explicit text/json fields.

The current `.gitignore` change for runtime `data/` is outside this spec and should be handled separately. This redesign should be implemented in focused commits with tests before behavior changes.
