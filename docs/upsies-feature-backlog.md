# Upsies Feature Backlog

Upsies is useful as a reference for upload workflow depth. Popcorn Queue should
borrow the product ideas and phase coverage, but implement them as backend jobs,
web review screens, and browser-bridge actions instead of copying Python code.

## High-Value Features

- Job graph runner: model each upload as restartable phases with dependency
  outputs, cancellation, retries, and per-phase logs.
- Metadata autofill: enrich candidates through IMDb, TMDb, and TVmaze before
  the PTP draft is created.
- Release name builder: generate normalized release names and show every parsed
  component in review before upload.
- Scene and predb checks: query sources such as SRRDB-style pre databases and
  expose confidence, missing proof, and scene mismatch warnings.
- Screenshot pipeline: pick timestamps, create stills, optimize images, upload
  to multiple hosts with fallback, and attach hosted URLs to the PTP draft.
- Torrent reuse: preserve piece hashes when possible and avoid regenerating a
  torrent if a compatible source torrent already exists.
- Disc and playlist parsing: detect Blu-ray/DVD structures, playlists, discs,
  and edition signals before deciding the upload type.
- Audio/subtitle extraction: infer languages, codecs, commentary tracks, and
  subtitle availability from MediaInfo.
- Tracker rules as code: keep PTP-specific bans and warnings in testable rule
  modules, including banned groups and container/source constraints.
- Review prompts: convert Upsies-style interactive confirmation into web review
  gates for trumpable flags, duplicate conflicts, missing metadata, and risky
  rule outcomes.

## UI Mapping

These features should appear as queue phases and inspector panels. The operator
should be able to open a job, see phase evidence, accept or override detected
metadata, and retry a failed phase without restarting the whole upload.

The browser bridge should only collect page context and source torrents. PTP API
credentials, cache entries, tracker rules, and upload orchestration belong in
the backend.
