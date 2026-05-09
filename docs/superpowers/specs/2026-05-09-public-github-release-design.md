# Public GitHub Release Preparation Design

## Goal

Prepare Popcorn Queue for a public GitHub repository release. The release should be safe to publish, understandable to outside users, and easy to verify without connecting to real PTP, image hosts, qBittorrent, or private tracker services.

The preferred approach is a GitHub-ready public release pass, not a minimal private backup and not a clean-history rebuild unless the safety scan finds committed secrets.

## Non-Goals

This work does not add new upload workflow features. It does not publish real `.env` values, cookies, API keys, tracker announce URLs, torrent files, downloaded media, local databases, or runtime logs. It does not make automated tests depend on real external systems.

## Safety Gate

The first implementation step is a publication safety scan. The scan checks tracked files, ignored runtime paths, and git history for sensitive material such as `.env`, PTP credentials, API keys, cookies, qBittorrent credentials, announce URLs, real `.torrent` files, media downloads, SQLite databases, and logs.

If no sensitive data is found in history, the existing repository history can be published after cleanup. If sensitive data appears in history, the release switches to a clean public history strategy: create a new public branch or repository from the current sanitized tree without the old commits.

The `.gitignore` must continue to exclude runtime state: `.env`, `data/`, `logs/`, `node_modules/`, `dist/`, Playwright reports, test results, TypeScript build info, and local database files. `.env.example` remains tracked and must contain placeholders only.

## Public Project Packaging

The README should become the public landing page for the project. It should explain what Popcorn Queue is, show the existing generated screenshots, summarize the major workflows, and give a clear first-run path. It should avoid implying that automated tests will contact real PTP or qBittorrent.

The README should include these sections: overview, screenshots, feature list, architecture, quick start, configuration, running locally, userscript/browser bridge setup, logs, testing, external integrations, limitations, and safety notes.

The repo should include an MIT `LICENSE` for this release. MIT fits the current tool-oriented TypeScript project and keeps reuse straightforward. If a stricter copyleft license is desired later, it should be decided before publishing the first public release.

The existing generated assets under `docs/assets/` should be kept. The release workflow should regenerate them from mock data with `npm run screenshots` before publishing, so GitHub screenshots and social preview reflect the current UI.

## Documentation Layout

User-facing docs stay in `docs/`: architecture, API, browser bridge, manual testing, migration, UI direction, and integration notes. Internal superpowers specs and plans can remain in `docs/superpowers/` as development history, but the README should not make them the main reader path.

Manual testing docs should clearly separate safe mock/test commands from manual integration testing that may contact PTP, ImgBB, qBittorrent, MediaInfo, ffmpeg, or mkvmerge.

## CI and Verification

Add GitHub Actions for public validation. The CI should run on pull requests and pushes to the default branch using a stable Node runtime. The workflow should run `npm ci`, `npm test`, `npm run typecheck`, and the mocked Chromium desktop Playwright suite.

Playwright CI must use only mocked UI/API routes and should not require real credentials. The workflow should install Chromium dependencies explicitly, then run `npm run test:e2e -- --project=chromium-desktop`.

Before the release commit, run local verification: `git diff --check`, the safety scan, `npm test`, `npm run typecheck`, `npm run test:e2e -- --project=chromium-desktop`, and `npm run screenshots`.

## Commit and Publish Flow

Because the working tree currently contains functional product changes, the implementation should keep commit boundaries readable. First, commit the current product changes after tests pass. Then commit the GitHub release cleanup separately.

Suggested commit split:

1. `feat: complete manual intake and upload feedback`
2. `chore: prepare public github release`

After cleanup, the user creates or provides the GitHub repository URL. The local repo can then add the remote and push the branch. If the safety gate requires a clean-history release, push the sanitized branch or repository instead of the existing history.

## Success Criteria

The public repository has no tracked secrets or runtime data, has a useful README, has a license, has a safe `.env.example`, includes current screenshots, passes local tests, and has CI that validates mock-only tests. A new user can clone the repo, install dependencies, copy `.env.example`, run tests, and understand what manual external setup is required.
