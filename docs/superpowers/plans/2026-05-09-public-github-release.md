# Public GitHub Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare Popcorn Queue for a safe, understandable public GitHub release.

**Architecture:** Keep the product code unchanged except for packaging and release validation. Add a local public-release audit script, GitHub CI, README/LICENSE cleanup, and a final verification pass that proves the repo is safe to publish with mock-only tests.

**Tech Stack:** Node.js, TypeScript, npm workspaces, Vitest, Playwright, GitHub Actions.

---

## File Structure

- Modify `package.json`: add a public release audit script.
- Create `scripts/public-release-audit.ts`: scan tracked files and git history for sensitive paths or secret-like values.
- Create `scripts/public-release-audit.test.ts`: validate the audit helper functions against representative safe and unsafe inputs.
- Modify `README.md`: make it the public GitHub landing page.
- Create `LICENSE`: MIT license for public release.
- Create `.github/workflows/ci.yml`: run install, tests, typecheck, public audit, and mocked Chromium desktop e2e.
- Keep `.env.example`: review values are safe; edit only if real values or machine-specific hostnames appear.
- Do not add `data/`, `logs/`, `.env`, `node_modules/`, `test-results/`, local databases, cookies, downloaded media, or generated runtime files.

### Task 1: Commit Current Product Work Before Release Cleanup

**Files:**
- Stage existing product changes already present in the working tree.
- Do not stage `docs/superpowers/plans/2026-05-09-public-github-release.md` in this task.

- [ ] **Step 1: Review current product diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: modified files include manual intake, upload feedback, API docs, tests, and related web/API/worker/core files.

- [ ] **Step 2: Run focused verification for current product changes**

Run:

```bash
npm test -- apps/api/src/server.test.ts
npm --workspace @popcorn-queue/web run typecheck
npm run test:e2e -- --project=chromium-desktop
```

Expected: API server tests pass, web typecheck passes, and desktop Playwright e2e passes with skipped mobile-only tests.

- [ ] **Step 3: Stage current product changes**

Run:

```bash
git add .env.example \
  apps/api/src/config.test.ts \
  apps/api/src/config.ts \
  apps/api/src/intake.ts \
  apps/api/src/server.test.ts \
  apps/api/src/server.ts \
  apps/web/e2e/ui.spec.ts \
  apps/web/src/App.tsx \
  apps/web/src/api.ts \
  apps/web/src/components/NewJobPage.tsx \
  apps/web/src/components/QueueTable.tsx \
  apps/web/src/styles.css \
  apps/web/src/types.ts \
  apps/worker/src/phases.test.ts \
  apps/worker/src/phases.ts \
  docs/api.md \
  docs/manual-testing.md \
  packages/core/src/manual-intake.test.ts \
  packages/core/src/manual-intake.ts
```

Expected: only these product-change files are staged.

- [ ] **Step 4: Commit current product changes**

Run:

```bash
git commit -m "feat: complete manual intake and upload feedback"
```

Expected: commit succeeds and leaves only public-release plan or release-cleanup files unstaged.

### Task 2: Add Public Release Audit Script

**Files:**
- Create: `scripts/public-release-audit.ts`
- Create: `scripts/public-release-audit.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write tests for path and secret detection**

Create `scripts/public-release-audit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findSensitivePathMatch, findSecretTextMatch } from "./public-release-audit.js";

describe("public release audit helpers", () => {
  it("allows tracked templates and source files", () => {
    expect(findSensitivePathMatch(".env.example")).toBeNull();
    expect(findSensitivePathMatch("logs/.gitkeep")).toBeNull();
    expect(findSensitivePathMatch("packages/integrations/src/torrent-clients.ts")).toBeNull();
  });

  it("flags runtime and private paths", () => {
    expect(findSensitivePathMatch(".env")).toBe(".env");
    expect(findSensitivePathMatch("data/jobs/job-1/movie.mkv")).toBe("data/");
    expect(findSensitivePathMatch("logs/api.log")).toBe("logs/");
    expect(findSensitivePathMatch("popcorn-queue.db")).toBe("*.db");
    expect(findSensitivePathMatch("cookies/ptp-cookies.txt")).toBe("cookie");
    expect(findSensitivePathMatch("upload/source.torrent")).toBe("*.torrent");
  });

  it("allows empty example settings", () => {
    expect(findSecretTextMatch(".env.example", "PTP_API_KEY=")).toBeNull();
    expect(findSecretTextMatch(".env.example", "QBITTORRENT_PASSWORD=")).toBeNull();
    expect(findSecretTextMatch("README.md", "PTP_API_KEY=your-key")).toBeNull();
  });

  it("flags likely committed secrets", () => {
    expect(findSecretTextMatch(".env", "PTP_API_KEY=abc123abc123abc123")).toContain("PTP_API_KEY");
    expect(findSecretTextMatch(".env", "PTP_PASSWORD=not-a-real-password-but-secret")).toContain("PTP_PASSWORD");
    expect(findSecretTextMatch(".env", "IMGBB_API_KEY=0123456789abcdef0123456789abcdef")).toContain("IMGBB_API_KEY");
    expect(findSecretTextMatch("config.yml", "passkey: 0123456789abcdef0123456789abcdef")).toContain("passkey");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- scripts/public-release-audit.test.ts
```

Expected: FAIL because `scripts/public-release-audit.ts` does not exist.

- [ ] **Step 3: Implement the audit script**

Create `scripts/public-release-audit.ts`:

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const secretValuePattern = String.raw`[A-Za-z0-9_./:+@%=-]{12,}`;

const secretPatterns = [
  new RegExp(String.raw`\b(PTP_API_KEY|PTP_PASSWORD|PTP_USERNAME|IMGBB_API_KEY|TMDB_API_KEY|PTPIMG_API_KEY|QBITTORRENT_PASSWORD|POPCORN_QUEUE_BROWSER_TOKEN)\s*[:=]\s*["']?${secretValuePattern}`, "i"),
  new RegExp(String.raw`\b(passkey|announce|cookie|session|auth|authorization)\s*[:=]\s*["']?${secretValuePattern}`, "i")
];

const safeExampleValue = /^(PTP_API_KEY|PTP_PASSWORD|PTP_USERNAME|IMGBB_API_KEY|TMDB_API_KEY|PTPIMG_API_KEY|QBITTORRENT_PASSWORD|POPCORN_QUEUE_BROWSER_TOKEN)=($|change-me$|your-[a-z-]+$)/i;

const sensitivePathRules: Array<{ label: string; test: (filePath: string) => boolean }> = [
  { label: ".env", test: (filePath) => filePath === ".env" || filePath.endsWith("/.env") },
  { label: "data/", test: (filePath) => filePath === "data" || filePath.startsWith("data/") },
  { label: "logs/", test: (filePath) => filePath.startsWith("logs/") && filePath !== "logs/.gitkeep" },
  { label: "node_modules/", test: (filePath) => filePath === "node_modules" || filePath.includes("/node_modules/") || filePath.startsWith("node_modules/") },
  { label: "test-results/", test: (filePath) => filePath === "test-results" || filePath.startsWith("test-results/") },
  { label: "*.db", test: (filePath) => /\.db(-.+)?$/i.test(filePath) },
  { label: "*.torrent", test: (filePath) => /\.torrent$/i.test(filePath) },
  { label: "cookie", test: (filePath) => /cookie|cookies/i.test(filePath) },
  { label: "config.yml", test: (filePath) => /(^|\/)config\.ya?ml$/i.test(filePath) }
];

function runGit(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

function trackedFilesAtRevision(revision: string): string[] {
  return runGit(["ls-tree", "-r", "--name-only", revision]).split("\n").filter(Boolean);
}

function currentTrackedFiles(): string[] {
  return runGit(["ls-files"]).split("\n").filter(Boolean);
}

function allRevisions(): string[] {
  return runGit(["rev-list", "--all"]).split("\n").filter(Boolean);
}

export function findSensitivePathMatch(filePath: string): string | null {
  const normalized = filePath.split(path.sep).join("/");
  if (normalized === ".env.example") return null;
  for (const rule of sensitivePathRules) {
    if (rule.test(normalized)) return rule.label;
  }
  return null;
}

export function findSecretTextMatch(filePath: string, text: string): string | null {
  const normalized = filePath.split(path.sep).join("/");
  if (normalized === ".env.example" || normalized.endsWith("/.env.example")) {
    const unsafeLine = text.split(/\r?\n/).find((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return false;
      return secretPatterns.some((pattern) => pattern.test(trimmed)) && !safeExampleValue.test(trimmed);
    });
    return unsafeLine ? unsafeLine.trim() : null;
  }

  const unsafeLine = text.split(/\r?\n/).find((line) => secretPatterns.some((pattern) => pattern.test(line)));
  return unsafeLine ? unsafeLine.trim() : null;
}

function auditCurrentFiles(): string[] {
  const findings: string[] = [];
  for (const filePath of currentTrackedFiles()) {
    const pathMatch = findSensitivePathMatch(filePath);
    if (pathMatch) findings.push(`tracked path ${filePath} matches ${pathMatch}`);

    try {
      const text = readFileSync(filePath, "utf8");
      const secretMatch = findSecretTextMatch(filePath, text);
      if (secretMatch) findings.push(`tracked text ${filePath} contains ${secretMatch}`);
    } catch {
      continue;
    }
  }
  return findings;
}

function auditHistoryPaths(): string[] {
  const findings: string[] = [];
  for (const revision of allRevisions()) {
    for (const filePath of trackedFilesAtRevision(revision)) {
      const pathMatch = findSensitivePathMatch(filePath);
      if (pathMatch) findings.push(`history ${revision.slice(0, 12)} path ${filePath} matches ${pathMatch}`);
    }
  }
  return findings;
}

function fileTextAtRevision(revision: string, filePath: string): string | null {
  try {
    return runGit(["show", `${revision}:${filePath}`]);
  } catch {
    return null;
  }
}

function auditHistoryText(): string[] {
  const findings: string[] = [];
  for (const revision of allRevisions()) {
    for (const filePath of trackedFilesAtRevision(revision)) {
      const text = fileTextAtRevision(revision, filePath);
      if (!text) continue;
      const secretMatch = findSecretTextMatch(filePath, text);
      if (secretMatch) findings.push(`history ${revision.slice(0, 12)} text ${filePath} contains ${secretMatch}`);
    }
  }
  return findings;
}

function main(): void {
  const findings = [...auditCurrentFiles(), ...auditHistoryPaths(), ...auditHistoryText()];
  if (findings.length) {
    console.error("Public release audit failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log("Public release audit passed.");
}

const entrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === entrypoint) main();
```

- [ ] **Step 4: Add npm script**

Modify the root `package.json` scripts section to include:

```json
"audit:public": "tsx scripts/public-release-audit.ts"
```

Keep the existing scripts unchanged.

- [ ] **Step 5: Run audit tests and script**

Run:

```bash
npm test -- scripts/public-release-audit.test.ts
npm run audit:public
```

Expected: tests pass. `npm run audit:public` either passes or prints concrete findings that require clean-history release handling.

- [ ] **Step 6: Commit audit tooling**

Run:

```bash
git add package.json scripts/public-release-audit.ts scripts/public-release-audit.test.ts
git commit -m "chore: add public release audit"
```

Expected: commit succeeds if the audit is not blocked by findings. If findings appear, stop implementation and report them before committing release cleanup.

### Task 3: Add GitHub CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches:
      - main
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright Chromium
        run: npx playwright install --with-deps chromium

      - name: Public release audit
        run: npm run audit:public

      - name: Unit tests
        run: npm test

      - name: Typecheck
        run: npm run typecheck

      - name: Mocked desktop e2e
        run: npm run test:e2e -- --project=chromium-desktop
```

- [ ] **Step 2: Validate workflow syntax by running equivalent local commands**

Run:

```bash
npm ci --dry-run
npm run audit:public
npm test
npm run typecheck
npm run test:e2e -- --project=chromium-desktop
```

Expected: commands complete locally. `npm ci --dry-run` should not modify dependencies.

- [ ] **Step 3: Commit CI workflow**

Run:

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add public release validation"
```

Expected: commit succeeds.

### Task 4: Add License

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Add MIT license**

Create `LICENSE`:

```text
MIT License

Copyright (c) 2026 Popcorn Queue contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Commit license**

Run:

```bash
git add LICENSE
git commit -m "chore: add license"
```

Expected: commit succeeds.

### Task 5: Rewrite Public README

**Files:**
- Modify: `README.md`
- Review: `docs/assets/screenshot-dashboard.png`
- Review: `docs/assets/screenshot-job-review.png`
- Review: `docs/assets/screenshot-diagnostics.png`
- Review: `docs/assets/social-preview.png`

- [ ] **Step 1: Replace README with public-facing content**

Replace `README.md` with:

```markdown
# Popcorn Queue

Popcorn Queue is a TypeScript upload-preparation queue for PassThePopcorn workflows. It combines a browser bridge, duplicate checking, upload draft generation, screenshot and MediaInfo review, qBittorrent handoff, and a compact operator UI.

The project is designed so automated tests run against mocks. Real PTP, image hosts, qBittorrent, ffmpeg, MediaInfo, mkvmerge, and tracker services are only used when you explicitly configure them for manual testing.

![Popcorn Queue social preview](docs/assets/social-preview.png)

## Screenshots

![Queue dashboard](docs/assets/screenshot-dashboard.png)

![Job review drawer](docs/assets/screenshot-job-review.png)

![Diagnostics](docs/assets/screenshot-diagnostics.png)

## Features

- Browser bridge endpoint for source-site handoff
- Manual job creation from a server media path or source torrent
- PTP movie target search and manual PTP/IMDb target confirmation
- Permanent API-side duplicate-check cache
- Automated prepare-to-review pipeline
- MediaInfo, screenshots, release draft, edition fields, subtitles, and trumpable review
- Explicit upload action before PTP submission
- qBittorrent progress and post-upload seeding handoff
- Global diagnostics for API, PTP, image host, qBittorrent, and local media tools
- File and job logs for operator visibility

## Repository Layout

- `apps/api` exposes the browser bridge API, job API, diagnostics, logs, and upload endpoints.
- `apps/web` is the light, QUI-style operator interface.
- `apps/worker` runs upload preparation phases.
- `apps/userscript/popcorn-queue-bridge.user.js` is the browser-side bridge userscript.
- `packages/core` contains shared types, release parsing, cache keys, and upload planning.
- `packages/integrations` contains PTP, image host, and qBittorrent integration clients.
- `docs` contains architecture, API, browser bridge, migration, and manual testing notes.

## Quick Start

```bash
npm install
cp .env.example .env
npm test
npm run typecheck
npm run test:e2e -- --project=chromium-desktop
npm run dev:api
npm run dev:web
```

The default development ports are:

- API: `http://127.0.0.1:3500`
- Web UI: `http://127.0.0.1:5173`

For remote development, set `POPCORN_QUEUE_HOST=0.0.0.0` and update `POPCORN_QUEUE_API_URL`, `POPCORN_QUEUE_WEB_URL`, `VITE_API_BASE_URL`, and `POPCORN_QUEUE_ALLOWED_ORIGINS` for your host.

## Configuration

Start from `.env.example`. Keep your real `.env` local; it is ignored by Git.

Important settings:

- `POPCORN_QUEUE_BROWSER_TOKEN`: shared token for browser bridge requests
- `PTP_API_USER` and `PTP_API_KEY`: PTP API duplicate-check credentials
- `PTP_USERNAME`, `PTP_PASSWORD`, and `PTP_COOKIE_FILE`: manual PTP upload login support
- `PTP_ANNOUNCE_URL`: announce URL used when creating upload torrents
- `IMGBB_API_KEY` or `PTPIMG_API_KEY`: optional image hosting
- `QBITTORRENT_URL`, `QBITTORRENT_USERNAME`, `QBITTORRENT_PASSWORD`: qBittorrent integration
- `POPCORN_QUEUE_RUN_EXTERNAL_TOOLS`: enables ffmpeg, MediaInfo, mkvmerge, and oxipng execution

Automated tests do not require any of these real values.

## Browser Bridge

Install `apps/userscript/popcorn-queue-bridge.user.js` in a userscript manager such as Tampermonkey. Use the userscript menu to configure the API URL, web URL, and browser token from your local `.env`.

The browser bridge can send source-site candidates and torrent files to the API. The web UI then prepares jobs for review.

## Running the App

Run the API and web UI in separate shells:

```bash
npm run dev:api
npm run dev:web
```

Open the web UI, create or receive a job, review the upload draft, then press `Upload` when ready. The UI shows pending upload feedback while the API waits for PTP.

## Logs

```bash
npm run logs:api
npm run logs:worker
npm run logs:job -- <jobId>
```

Runtime logs are written under `logs/` and job logs under `data/jobs/<jobId>/logs/`. These paths are ignored by Git.

## Tests

```bash
npm test
npm run typecheck
npm run test:e2e -- --project=chromium-desktop
npm run audit:public
```

The test suite uses mocked external systems. Do not wire tests to real PTP, qBittorrent, image hosts, or trackers.

## Screenshots and Social Preview

Screenshots are generated from mock data:

```bash
npm run screenshots
```

The generated files live under `docs/assets/` and are safe to commit.

## Safety Notes

Do not commit `.env`, cookies, tracker passkeys, announce URLs, `.torrent` files, downloaded media, local databases, or runtime logs. Run `npm run audit:public` before publishing.

## License

MIT
```

- [ ] **Step 2: Regenerate public screenshots**

Run:

```bash
npm run screenshots
```

Expected: `docs/assets/screenshot-dashboard.png`, `docs/assets/screenshot-job-review.png`, `docs/assets/screenshot-diagnostics.png`, and `docs/assets/social-preview.png` are present and visually current.

- [ ] **Step 3: Run README-related checks**

Run:

```bash
npm run audit:public
git diff -- README.md docs/assets
```

Expected: audit passes, README references existing image files, and screenshots are generated from mock data.

- [ ] **Step 4: Commit README and assets**

Run:

```bash
git add README.md docs/assets/screenshot-dashboard.png docs/assets/screenshot-job-review.png docs/assets/screenshot-diagnostics.png docs/assets/social-preview.png
git commit -m "docs: prepare public readme"
```

Expected: commit succeeds.

### Task 6: Final Public Release Verification

**Files:**
- No planned file edits.

- [ ] **Step 1: Confirm ignored runtime files are not tracked**

Run:

```bash
npm run audit:public
```

Expected: audit passes. If output includes real runtime files or history findings, remove tracked runtime files or switch to a clean-history public release before publishing.

- [ ] **Step 2: Run full release verification**

Run:

```bash
git diff --check
npm run audit:public
npm test
npm run typecheck
npm run test:e2e -- --project=chromium-desktop
```

Expected: all commands pass.

- [ ] **Step 3: Inspect final status**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: working tree is clean except intentional local-only ignored files; latest commits include product changes and public release cleanup.

- [ ] **Step 4: Provide publish instructions**

Report these commands to the user after they create the GitHub repository:

```bash
git remote add origin git@github.com:<owner>/<repo>.git
git branch -M main
git push -u origin main
```

If `npm run audit:public` found secrets in history, do not use these commands for the existing branch. Use a sanitized clean-history branch or new repository instead.
