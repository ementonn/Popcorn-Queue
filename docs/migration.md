# Migration Notes

The new project does not modify legacy folders. Legacy projects are reference
sources only.

## From PtpUploader

Carry forward:

- PTP login/upload behavior.
- qBittorrent/rTorrent/Transmission concepts.
- MediaInfo, screenshots, subtitles, image host, source-specific parsing.
- safe delete protections.

Replace:

- thread-local worker state with durable job phases.
- SQLite multi-thread coordination with PostgreSQL/BullMQ in production.
- Django templates with the Popcorn Queue web app.

## From ptp_checker

Carry forward:

- site parsers for TJUPT, PTer, M-Team, HDBits, HHClub.
- badge workflow and `Up` action.
- PTP slot rule concepts.

Replace:

- direct PTP API calls with backend API calls.
- `GM_setValue` long-lived cache with backend cache.
- hardcoded credentials with a browser token.

## From Upload-Assistant

Carry forward as TypeScript references:

- PTP API endpoints and lookup patterns.
- MediaInfo/BDInfo preparation ideas.
- naming and description generation ideas.
- client fast-resume/seeding flow.

Do not embed the Python CLI as a runtime dependency for v1.
