# New Job Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `New Job` page that creates manual upload jobs from a server-side media file, a browser-uploaded or URL-downloaded source torrent, and a user-confirmed PTP movie group.

**Architecture:** Core owns reusable intake contracts and PTP movie display helpers. The API owns server path validation, PTP search, torrent upload/download intake, job workspace creation, and preparation enqueueing. The worker already supports `mediaPath`; the API will pass manual media paths into preparation. The web app adds a third top-level view with a dense operational form and mocked Playwright coverage.

**Tech Stack:** TypeScript, Fastify, @fastify/multipart, React, Vite, Vitest, Playwright, existing `@popcorn-queue/core`, `@popcorn-queue/api`, `@popcorn-queue/worker`, and `@popcorn-queue/integrations` packages.

---

## Approved Spec

Use `docs/superpowers/specs/2026-05-09-new-job-intake-design.md`.

Confirmed product decisions:

- Manual jobs do not need source tracker site/source URL.
- The media file path is a server-side movie file path.
- Source torrent comes from a browser `.torrent` upload or a torrent download URL.
- The user clicks `Search PTP Movie`, confirms a PTP result, and that confirmed group drives `reviewDraft.groupId`.
- PTP result titles render as clickable group links such as `https://passthepopcorn.me/torrents.php?id=205678`.
- Tests must mock PTP, torrent URL downloads, qB, and upload submit.

## File Structure

Core:

- Create `packages/core/src/manual-intake.ts`: shared intake API types, video extension list, PTP group URL builder, PTP movie display formatter, and conversion from `PtpMovie` to confirmed target.
- Create `packages/core/src/manual-intake.test.ts`: pure helper tests.
- Modify `packages/core/src/index.ts`: export manual intake helpers.

API:

- Modify `apps/api/src/config.ts`: add `paths.mediaRoots` from `POPCORN_QUEUE_MEDIA_ROOTS`.
- Modify `apps/api/src/config.test.ts`: cover media root parsing and absolute path resolution.
- Create `apps/api/src/intake.ts`: media path validation, PTP movie search result formatting, torrent buffer validation, torrent URL download helper, multipart intake parser, and job creation helper.
- Modify `apps/api/src/server.ts`: add `fetchImpl` build option, instantiate intake routes, pass `job.source.mediaPath` into preparation, and add the three `/api/intake/*` routes.
- Modify `apps/api/src/server.test.ts`: route-level tests for media validation, PTP search, upload intake, URL intake, and rejection paths.
- Modify `apps/api/src/preparation.ts`: include `job.source.mediaPath` in worker input.
- Modify `apps/api/src/preparation.test.ts`: assert manual media path jobs do not call qB and still prepare media.
- Modify `.env.example`: document `POPCORN_QUEUE_MEDIA_ROOTS`.

Worker:

- No new worker phase is required. Existing `WorkerJobInput.mediaPath`, `download-or-locate`, and `prepare-media` behavior are reused.

Web:

- Modify `apps/web/src/types.ts`: add intake request/response types and widen `ApiJob.source` with manual intake fields.
- Modify `apps/web/src/api.ts`: support FormData requests and add `validateMediaPath`, `searchPtpMovie`, and `createManualIntakeJob`.
- Create `apps/web/src/components/NewJobPage.tsx`: page form, validation state, torrent source segmented control, PTP result confirmation, and create action.
- Modify `apps/web/src/App.tsx`: add `new-job` navigation, success redirect to Jobs, and selected-job handling.
- Modify `apps/web/src/styles.css`: add form, segmented control, result list, and selected target styles.
- Modify `apps/web/e2e/ui.spec.ts`: mocked end-to-end coverage for the new page.

Docs:

- Modify `docs/api.md`: document intake endpoints.
- Modify `docs/manual-testing.md`: add manual local test steps for `/home/emt/data` style media paths.

## Data Contracts

Add this shared contract in `packages/core/src/manual-intake.ts`:

```ts
import path from "node:path";
import type { PtpMovie } from "./types.js";

export interface MediaPathValidationResult {
  ok: boolean;
  mediaPath: string;
  basename: string;
  kind: "file" | "directory" | "missing" | "outside-root" | "relative" | "unsupported" | "unreadable";
  size: number | null;
  error: string | null;
}

export interface ManualIntakePtpTarget {
  groupId: string;
  displayTitle: string;
  year: string | null;
  imdbId: string | null;
  ptpUrl: string;
}

export interface PtpMovieSearchCandidate extends ManualIntakePtpTarget {
  title: string;
  raw: PtpMovie;
}

export interface PtpMovieSearchResponse {
  query: string;
  parsedYear: string | null;
  results: PtpMovieSearchCandidate[];
}

export const VIDEO_FILE_EXTENSIONS = new Set([
  ".mkv",
  ".mp4",
  ".m2ts",
  ".ts",
  ".mov",
  ".avi"
]);

export function mediaTitleFromPath(mediaPath: string): string {
  return path.basename(mediaPath).replace(/\.[^.]+$/, "");
}

export function buildPtpGroupUrl(groupId: string): string {
  return `https://passthepopcorn.me/torrents.php?id=${encodeURIComponent(groupId)}`;
}

export function formatPtpMovieTitle(movie: PtpMovie): string {
  const primary = (movie.Title || movie.Name || "").trim();
  const aka = movie.Name && movie.Title && movie.Name !== movie.Title ? ` AKA ${movie.Name}` : "";
  const year = movie.Year ? ` [${movie.Year}]` : "";
  return `${primary}${aka}${year}`.trim();
}

export function ptpTargetFromMovie(movie: PtpMovie): PtpMovieSearchCandidate | null {
  if (!movie.GroupId) return null;
  const displayTitle = formatPtpMovieTitle(movie);
  return {
    groupId: movie.GroupId,
    title: movie.Title || movie.Name || displayTitle,
    displayTitle,
    year: movie.Year || null,
    imdbId: movie.ImdbId || null,
    ptpUrl: buildPtpGroupUrl(movie.GroupId),
    raw: movie
  };
}
```

`Job["source"]` gains optional manual intake fields without a database migration because `source` already persists as JSON:

```ts
source: {
  site?: string;
  url?: string;
  title?: string;
  mediaPath?: string;
  torrentUrl?: string;
  ptpTarget?: ManualIntakePtpTarget;
}
```

Manual intake creates a `BrowserCheckResult` from the confirmed target so existing review draft code fills `groupId`:

```ts
const checkResult: BrowserCheckResult = {
  candidate,
  parsed: parseTorrentTitle(candidate.title, candidate.resolution),
  decision: {
    status: "review",
    movieFound: true,
    movie: {
      GroupId: target.groupId,
      Title: target.title,
      Name: target.displayTitle,
      Year: target.year ?? "",
      ImdbId: target.imdbId ?? "",
      Torrents: []
    },
    ptpUrl: target.ptpUrl,
    reason: "Manual PTP target confirmed.",
    confidence: "high"
  },
  cache: { key: `ptp:group:${target.groupId}`, hit: false, policy: "permanent" }
};
```

---

### Task 1: Core Intake Contracts

**Files:**
- Create: `packages/core/src/manual-intake.ts`
- Create: `packages/core/src/manual-intake.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing helper tests**

Create `packages/core/src/manual-intake.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPtpGroupUrl, formatPtpMovieTitle, mediaTitleFromPath, ptpTargetFromMovie, VIDEO_FILE_EXTENSIONS } from "./manual-intake.js";

describe("manual intake helpers", () => {
  it("builds display titles and clickable PTP group URLs", () => {
    const target = ptpTargetFromMovie({
      GroupId: "205678",
      Title: "Skaz pro to, kak tsar Pyotr arapa zhenil",
      Name: "How Czar Peter the Great Married Off His Moor",
      Year: "1976",
      ImdbId: "tt0075169",
      Torrents: []
    });

    expect(target).toMatchObject({
      groupId: "205678",
      displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
      imdbId: "tt0075169",
      ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
    });
  });

  it("returns null when a PTP movie has no group id", () => {
    expect(ptpTargetFromMovie({ Title: "No Group", Year: "2024", Torrents: [] })).toBeNull();
  });

  it("derives release titles from media file paths", () => {
    expect(mediaTitleFromPath("/home/emt/data/Movie.2024.1080p.WEB-DL.mkv")).toBe("Movie.2024.1080p.WEB-DL");
    expect(VIDEO_FILE_EXTENSIONS.has(".mkv")).toBe(true);
    expect(VIDEO_FILE_EXTENSIONS.has(".txt")).toBe(false);
    expect(formatPtpMovieTitle({ GroupId: "1", Title: "Only Title", Year: "2025", Torrents: [] })).toBe("Only Title [2025]");
    expect(buildPtpGroupUrl("12 3")).toBe("https://passthepopcorn.me/torrents.php?id=12%203");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm test -- packages/core/src/manual-intake.test.ts
```

Expected: fail because `packages/core/src/manual-intake.ts` does not exist.

- [ ] **Step 3: Implement helpers**

Create `packages/core/src/manual-intake.ts` with the code from the `Data Contracts` section.

Modify `packages/core/src/index.ts`:

```ts
export * from "./manual-intake.js";
```

- [ ] **Step 4: Verify core helper tests**

Run:

```bash
npm test -- packages/core/src/manual-intake.test.ts
npm --workspace @popcorn-queue/core run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/manual-intake.ts packages/core/src/manual-intake.test.ts packages/core/src/index.ts
git commit -m "feat(core): add manual intake contracts"
```

---

### Task 2: API Intake Service And Routes

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/config.test.ts`
- Create: `apps/api/src/intake.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`
- Modify: `.env.example`
- Modify: `docs/api.md`

- [ ] **Step 1: Write failing config tests**

Append to `apps/api/src/config.test.ts`:

```ts
it("parses configured media roots as absolute project paths", () => {
  const config = loadConfig({
    POPCORN_QUEUE_MEDIA_ROOTS: "data/media,/home/emt/data",
    POPCORN_QUEUE_DATA_ROOT: "data",
    POPCORN_QUEUE_LOG_TO_CONSOLE: "false"
  });

  expect(config.paths.mediaRoots[0]).toMatch(/popcorn-queue[/\\]data[/\\]media$/);
  expect(config.paths.mediaRoots[1]).toBe("/home/emt/data");
});
```

- [ ] **Step 2: Write failing API route tests**

Append these tests to `apps/api/src/server.test.ts`:

```ts
it("validates manual intake media paths inside configured roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-media-root-"));
  const movie = path.join(root, "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv");
  await writeFile(movie, "movie");
  const config = testConfig();
  config.paths.mediaRoots = [root];

  await withServer(async (app) => {
    const ok = await app.inject({
      method: "POST",
      url: "/api/intake/media-path/validate",
      payload: { mediaPath: movie }
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, basename: path.basename(movie), kind: "file", error: null });

    const outside = await app.inject({
      method: "POST",
      url: "/api/intake/media-path/validate",
      payload: { mediaPath: "/etc/passwd" }
    });
    expect(outside.statusCode).toBe(200);
    expect(outside.json()).toMatchObject({ ok: false, kind: "outside-root" });
  }, { autoPrepare: false });
});

it("searches PTP movies from a manual release name without creating a job", async () => {
  const search = vi.spyOn(PtpClient.prototype, "searchByCandidate").mockResolvedValue({
    totalResults: 1,
    movies: [
      {
        GroupId: "205678",
        Title: "Skaz pro to, kak tsar Pyotr arapa zhenil",
        Name: "How Czar Peter the Great Married Off His Moor",
        Year: "1976",
        ImdbId: "tt0075169",
        Torrents: []
      }
    ]
  });

  await withServer(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/intake/ptp-search",
      payload: { title: "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.WEB-DL.x265-GROUP" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      query: "Skaz pro to kak tsar Pyotr arapa zhenil",
      parsedYear: "1976",
      results: [
        {
          groupId: "205678",
          displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
          ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
        }
      ]
    });
    expect(search).toHaveBeenCalledTimes(1);
  }, { autoPrepare: false });
});

it("creates manual intake jobs from server media and uploaded torrent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-upload-"));
  const mediaPath = path.join(root, "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
  await writeFile(mediaPath, "movie");
  const config = testConfig();
  config.paths.mediaRoots = [root];
  const boundary = "popcorn-manual-intake-upload";

  await withServer(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/intake/jobs",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(
        boundary,
        {
          mediaPath,
          releaseName: "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP",
          ptpTarget: JSON.stringify({
            groupId: "205678",
            displayTitle: "Manual Movie [2024]",
            year: "2024",
            imdbId: "tt1234567",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
          })
        },
        {
          name: "torrent",
          filename: "Manual.Movie.source.torrent",
          contentType: "application/x-bittorrent",
          value: "d4:infod6:lengthi1eee"
        }
      )
    });

    expect(response.statusCode).toBe(201);
    const job = response.json<{ job: Job }>().job;
    expect(job.source).toMatchObject({
      site: "unknown",
      title: "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP",
      mediaPath,
      ptpTarget: { groupId: "205678", ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678" }
    });
    expect(job.reviewDraft).toMatchObject({ groupId: "205678", imdb: "tt1234567" });
    expect(job.torrent).toMatchObject({ filename: "Manual.Movie.source.torrent" });
    await expect(access(job.torrent!.filePath!)).resolves.toBeUndefined();
  }, { autoPrepare: false });
});
```

Add a fourth test for torrent URL intake with mocked fetch:

```ts
it("creates manual intake jobs from a torrent URL without real network", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-url-"));
  const mediaPath = path.join(root, "Url.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
  await writeFile(mediaPath, "movie");
  const config = testConfig();
  config.paths.mediaRoots = [root];
  const fetchImpl: typeof fetch = async () =>
    new Response("d4:infod6:lengthi1eee", {
      status: 200,
      headers: { "content-type": "application/x-bittorrent", "content-disposition": 'attachment; filename="Url.Movie.source.torrent"' }
    });

  await withServer(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/intake/jobs",
      payload: {
        mediaPath,
        releaseName: "Url.Movie.2024.1080p.WEB-DL.x265-GROUP",
        torrentUrl: "https://tracker.example/download/1.torrent",
        ptpTarget: {
          groupId: "300",
          displayTitle: "Url Movie [2024]",
          year: "2024",
          imdbId: "tt7654321",
          ptpUrl: "https://passthepopcorn.me/torrents.php?id=300"
        }
      }
    });

    expect(response.statusCode).toBe(201);
    const job = response.json<{ job: Job }>().job;
    expect(job.source).toMatchObject({ mediaPath, torrentUrl: "https://tracker.example/download/1.torrent" });
    expect(job.torrent).toMatchObject({ filename: "Url.Movie.source.torrent", contentType: "application/x-bittorrent" });
  }, { autoPrepare: false, fetchImpl });
});
```

- [ ] **Step 3: Run route tests and confirm failures**

Run:

```bash
npm test -- apps/api/src/config.test.ts apps/api/src/server.test.ts
```

Expected: fail on missing `mediaRoots`, missing intake routes, and missing `fetchImpl` option.

- [ ] **Step 4: Implement config**

Modify `apps/api/src/config.ts`:

```ts
paths: {
  dataRoot: string;
  apiLogFile: string;
  workerLogFile: string;
  mediaRoots: string[];
};
```

Add:

```ts
function splitPaths(value: string | undefined): string[] {
  return splitCsv(value).map((item) => resolveProjectPath(item, item));
}
```

Set:

```ts
mediaRoots: splitPaths(env.POPCORN_QUEUE_MEDIA_ROOTS)
```

Update `testConfig()` objects in tests with `mediaRoots: []`.

- [ ] **Step 5: Implement intake service**

Create `apps/api/src/intake.ts` with these exports:

```ts
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildJobWorkspacePaths,
  mediaTitleFromPath,
  parseTorrentTitle,
  ptpTargetFromMovie,
  VIDEO_FILE_EXTENSIONS,
  type BrowserCheckResult,
  type ManualIntakePtpTarget,
  type MediaPathValidationResult,
  type PtpMovieSearchResponse,
  type TorrentCandidate
} from "@popcorn-queue/core";
import type { PtpClient } from "@popcorn-queue/integrations";
import type { Job } from "./jobs.js";

export function isPathInsideRoot(filePath: string, roots: string[]): boolean {
  const resolved = path.resolve(filePath);
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

export async function validateMediaPath(mediaPath: string, roots: string[]): Promise<MediaPathValidationResult> {
  const basename = mediaPath ? path.basename(mediaPath) : "";
  if (!mediaPath) return { ok: false, mediaPath, basename, kind: "missing", size: null, error: "media_path_required" };
  if (!path.isAbsolute(mediaPath)) return { ok: false, mediaPath, basename, kind: "relative", size: null, error: "absolute_media_path_required" };
  if (!roots.length || !isPathInsideRoot(mediaPath, roots)) {
    return { ok: false, mediaPath, basename, kind: "outside-root", size: null, error: "media_path_outside_allowed_roots" };
  }
  try {
    await access(mediaPath);
    const info = await stat(mediaPath);
    if (!info.isFile()) return { ok: false, mediaPath, basename, kind: "unsupported", size: null, error: "media_path_must_be_file" };
    if (!VIDEO_FILE_EXTENSIONS.has(path.extname(mediaPath).toLowerCase())) {
      return { ok: false, mediaPath, basename, kind: "unsupported", size: info.size, error: "unsupported_media_extension" };
    }
    return { ok: true, mediaPath, basename, kind: "file", size: info.size, error: null };
  } catch {
    return { ok: false, mediaPath, basename, kind: "unreadable", size: null, error: "media_path_unreadable" };
  }
}

export async function searchPtpMovies(input: { title?: string; mediaPath?: string }, ptpClient: PtpClient): Promise<PtpMovieSearchResponse> {
  const title = (input.title?.trim() || (input.mediaPath ? mediaTitleFromPath(input.mediaPath) : "")).trim();
  if (!title) return { query: "", parsedYear: null, results: [] };
  const parsed = parseTorrentTitle(title);
  const response = await ptpClient.searchByCandidate({
    title,
    searchName: parsed.searchName,
    ...(parsed.year ? { year: parsed.year } : {})
  });
  return {
    query: parsed.searchName,
    parsedYear: parsed.year ?? null,
    results: response.movies.map(ptpTargetFromMovie).filter((item): item is NonNullable<typeof item> => Boolean(item))
  };
}

export function looksLikeTorrent(bytes: Buffer): boolean {
  return bytes.length > 0 && bytes[0] === 0x64 && bytes.includes(Buffer.from("4:info"));
}
```

Export `downloadTorrentFromUrl()` and `createManualIntakeJob()` from the same file with these signatures:

```ts
export interface IntakeTorrentInput {
  filename: string;
  bytes: Buffer;
  contentType?: string;
  sourceUrl?: string;
}

export async function downloadTorrentFromUrl(torrentUrl: string, fetchImpl: typeof fetch): Promise<IntakeTorrentInput>;

export async function createManualIntakeJob(input: {
  dataRoot: string;
  jobRepository: {
    createFromBrowser(value: Parameters<typeof import("./jobs.js").JobRepository.prototype.createFromBrowser>[0]): Promise<Job> | Job;
    attachWorkspace(id: string, value: { workspace: Job["workspace"]; torrentFilePath?: string }): Promise<Job | null> | Job | null;
  };
  mediaPath: string;
  releaseName: string;
  ptpTarget: ManualIntakePtpTarget;
  torrent: IntakeTorrentInput;
}): Promise<Job>;
```

`downloadTorrentFromUrl()` accepts only `http:` and `https:` URLs, uses the injected `fetchImpl`, reads `arrayBuffer()`, rejects non-torrent buffers with `invalid_torrent_file`, and derives the filename from `Content-Disposition` or URL pathname. `createManualIntakeJob()` creates a job through `createFromBrowser`, writes `paths.sourceTorrent` and `paths.sourceJson`, calls `attachWorkspace`, and returns the attached job.

- [ ] **Step 6: Wire server routes**

Modify `apps/api/src/server.ts` imports:

```ts
import { createManualIntakeJob, downloadTorrentFromUrl, searchPtpMovies, validateMediaPath } from "./intake.js";
```

Extend `BuildServerOptions`:

```ts
fetchImpl?: typeof fetch;
```

Add routes before the existing browser bridge routes:

```ts
app.post<{ Body: { mediaPath?: string } }>("/api/intake/media-path/validate", async (request) => {
  return validateMediaPath(request.body?.mediaPath ?? "", config.paths.mediaRoots);
});

app.post<{ Body: { title?: string; mediaPath?: string } }>("/api/intake/ptp-search", async (request) => {
  return searchPtpMovies(request.body ?? {}, ptpClient);
});

app.post("/api/intake/jobs", async (request, reply) => {
  const input = await readManualIntakeRequest(request, options.fetchImpl ?? fetch);
  const media = await validateMediaPath(input.mediaPath, config.paths.mediaRoots);
  if (!media.ok) return reply.code(400).send({ error: media.error ?? "invalid_media_path", media });
  const job = await createManualIntakeJob({
    dataRoot: config.paths.dataRoot,
    jobRepository,
    mediaPath: input.mediaPath,
    releaseName: input.releaseName,
    ptpTarget: input.ptpTarget,
    torrent: input.torrent
  });
  enqueuePreparation(job.id);
  return reply.code(201).send({ job });
});
```

`readManualIntakeRequest()` can live in `apps/api/src/intake.ts`; it must support both JSON and multipart requests.

- [ ] **Step 7: Document env and endpoints**

Add to `.env.example`:

```env
POPCORN_QUEUE_MEDIA_ROOTS=/home/emt/data
```

Add to `docs/api.md`:

```md
### Manual intake

`POST /api/intake/media-path/validate` validates an absolute server media file under `POPCORN_QUEUE_MEDIA_ROOTS`.

`POST /api/intake/ptp-search` searches PTP from a release name or media path and returns selectable group links.

`POST /api/intake/jobs` creates a manual job from `mediaPath`, `releaseName`, confirmed `ptpTarget`, and either uploaded `torrent` or `torrentUrl`.
```

- [ ] **Step 8: Verify API task**

Run:

```bash
npm test -- apps/api/src/config.test.ts apps/api/src/server.test.ts
npm --workspace @popcorn-queue/api run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 9: Commit**

```bash
git add .env.example docs/api.md apps/api/src/config.ts apps/api/src/config.test.ts apps/api/src/intake.ts apps/api/src/server.ts apps/api/src/server.test.ts
git commit -m "feat(api): add manual intake routes"
```

---

### Task 3: Preparation Uses Manual Server Media Path

**Files:**
- Modify: `apps/api/src/jobs.ts`
- Modify: `apps/api/src/preparation.ts`
- Modify: `apps/api/src/preparation.test.ts`
- Modify: `apps/api/src/persistence.ts`

- [ ] **Step 1: Write failing preparation test**

Append to `apps/api/src/preparation.test.ts`:

```ts
it("uses manual intake server media path directly without qB download", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-prep-manual-"));
  const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-media-manual-"));
  const mediaPath = path.join(mediaRoot, "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
  await writeFile(mediaPath, "movie");
  const sourceTorrentPath = path.join(dataRoot, "jobs", "manual-source.torrent");
  await mkdir(path.dirname(sourceTorrentPath), { recursive: true });
  await writeFile(sourceTorrentPath, "d4:infod6:lengthi1eee");

  const jobs = new JobRepository();
  const job = jobs.createFromBrowser({
    candidate: {
      site: "unknown",
      title: "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP",
      imdbId: "tt1234567"
    },
    torrent: {
      filename: "Manual.Movie.source.torrent",
      bytes: 21,
      filePath: sourceTorrentPath
    }
  });
  job.source = {
    ...job.source,
    mediaPath,
    ptpTarget: {
      groupId: "205678",
      displayTitle: "Manual Movie [2024]",
      year: "2024",
      imdbId: "tt1234567",
      ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
    }
  };

  const addCalls: unknown[] = [];
  const service = new PreparationService({
    dataRoot,
    jobs,
    runExternalTools: false,
    toolCommands: { ffmpeg: "ffmpeg", mediainfo: "mediainfo", oxipng: "oxipng" },
    torrentClient: {
      name: "mock-qb",
      async addTorrent(options) {
        addCalls.push(options);
        return { infoHash: "SHOULD_NOT_BE_USED" };
      },
      async getStatus() {
        throw new Error("qB status must not be requested for manual media paths");
      },
      async isComplete() {
        return false;
      },
      async listFiles() {
        return [];
      }
    }
  });

  await service.runJob(job.id);
  const prepared = jobs.get(job.id)!;
  expect(addCalls).toEqual([]);
  expect(prepared.artifacts.mediaFiles?.[0]).toMatch(/^media[/\\]upload[/\\]Manual\.Movie/);
  expect(prepared.events.some((event) => event.message.includes("Torrent is still downloading"))).toBe(false);
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
npm test -- apps/api/src/preparation.test.ts
```

Expected: fail until `PreparationService.workerJobInput()` reads `job.source.mediaPath`.

- [ ] **Step 3: Widen job source type**

Modify the `Job` interface in `apps/api/src/jobs.ts`:

```ts
source: {
  site?: string;
  url?: string;
  title?: string;
  mediaPath?: string;
  torrentUrl?: string;
  ptpTarget?: ManualIntakePtpTarget;
};
```

Import `ManualIntakePtpTarget` from `@popcorn-queue/core`.

Mirror this source shape in `apps/web/src/types.ts` during Task 4.

- [ ] **Step 4: Pass source media path into worker input**

Modify `apps/api/src/preparation.ts` in `workerJobInput()`:

```ts
return {
  ...input,
  ...(job.checkResult ? { checkResult: job.checkResult } : {}),
  ...(job.torrent ? { torrent: job.torrent } : {}),
  ...(job.torrent?.filePath ? { sourceTorrentPath: job.torrent.filePath } : {}),
  ...(job.source.mediaPath ? { mediaPath: job.source.mediaPath } : {})
};
```

- [ ] **Step 5: Verify preparation task**

Run:

```bash
npm test -- apps/api/src/preparation.test.ts
npm --workspace @popcorn-queue/api run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs.ts apps/api/src/preparation.ts apps/api/src/preparation.test.ts apps/api/src/persistence.ts
git commit -m "feat(api): prepare manual media paths"
```

---

### Task 4: Web New Job Page

**Files:**
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/components/NewJobPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/e2e/ui.spec.ts`
- Modify: `docs/manual-testing.md`

- [ ] **Step 1: Write failing Playwright test**

Append to `apps/web/e2e/ui.spec.ts`:

```ts
test("creates a manual job from server media path, uploaded torrent, and confirmed PTP target", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only intake assertion.");
  const requests: Array<{ url: string; method: string; body: string | null }> = [];

  await page.route("**/api/intake/media-path/validate", async (route) => {
    requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
    await route.fulfill({
      json: {
        ok: true,
        mediaPath: "/home/emt/data/Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv",
        basename: "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv",
        kind: "file",
        size: 1234,
        error: null
      }
    });
  });
  await page.route("**/api/intake/ptp-search", async (route) => {
    requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
    await route.fulfill({
      json: {
        query: "Skaz pro to kak tsar Pyotr arapa zhenil",
        parsedYear: "1976",
        results: [
          {
            groupId: "205678",
            title: "Skaz pro to, kak tsar Pyotr arapa zhenil",
            displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
            year: "1976",
            imdbId: "tt0075169",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678",
            raw: {}
          }
        ]
      }
    });
  });
  await page.route("**/api/intake/jobs", async (route) => {
    requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() });
    await route.fulfill({
      status: 201,
      json: {
        job: {
          ...apiJobs[0],
          id: "job-manual",
          source: {
            site: "unknown",
            title: "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p",
            mediaPath: "/home/emt/data/Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv",
            ptpTarget: {
              groupId: "205678",
              displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
              year: "1976",
              imdbId: "tt0075169",
              ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
            }
          }
        }
      }
    });
  });

  await page.goto("/");
  await page.getByRole("link", { name: /New Job/i }).click();
  await expect(page.getByRole("heading", { name: "New Job" })).toBeVisible();

  await page.getByLabel("Server media path").fill("/home/emt/data/Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv");
  await page.getByRole("button", { name: "Validate path" }).click();
  await expect(page.getByText("Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv")).toBeVisible();

  await page.setInputFiles('input[type="file"][name="torrent"]', {
    name: "source.torrent",
    mimeType: "application/x-bittorrent",
    buffer: Buffer.from("d4:infod6:lengthi1eee")
  });
  await page.getByLabel("Release name").fill("Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p");
  await page.getByRole("button", { name: "Search PTP Movie" }).click();

  const movieLink = page.getByRole("link", {
    name: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]"
  });
  await expect(movieLink).toHaveAttribute("href", "https://passthepopcorn.me/torrents.php?id=205678");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("PTP Target")).toBeVisible();
  await expect(page.getByText("Confirmed")).toBeVisible();

  await page.getByRole("button", { name: "Create Job" }).click();
  await expect(page.getByLabel("Upload queue")).toContainText("Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p");
  expect(requests.some((request) => request.url.includes("/api/intake/jobs") && request.method === "POST")).toBe(true);
});
```

- [ ] **Step 2: Run Playwright test and confirm failure**

Run:

```bash
npm run test:e2e -- --project=chromium-desktop apps/web/e2e/ui.spec.ts
```

Expected: fail because the `New Job` navigation and page do not exist.

- [ ] **Step 3: Add web types**

Modify `apps/web/src/types.ts`:

```ts
export interface ManualIntakePtpTarget {
  groupId: string;
  displayTitle: string;
  year: string | null;
  imdbId: string | null;
  ptpUrl: string;
}

export interface MediaPathValidationResult {
  ok: boolean;
  mediaPath: string;
  basename: string;
  kind: "file" | "directory" | "missing" | "outside-root" | "relative" | "unsupported" | "unreadable";
  size: number | null;
  error: string | null;
}

export interface PtpMovieSearchCandidate extends ManualIntakePtpTarget {
  title: string;
  raw: unknown;
}

export interface PtpMovieSearchResponse {
  query: string;
  parsedYear: string | null;
  results: PtpMovieSearchCandidate[];
}
```

Extend `ApiJob.source`:

```ts
mediaPath?: string;
torrentUrl?: string;
ptpTarget?: ManualIntakePtpTarget;
```

- [ ] **Step 4: Add API client methods**

Modify `apps/web/src/api.ts` so `fetchJson()` does not force JSON content type for FormData:

```ts
const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
const headers = isFormData
  ? init?.headers
  : {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    };
const response = await fetch(`${apiBase}${path}`, { ...init, headers });
```

Add:

```ts
export function validateMediaPath(mediaPath: string): Promise<MediaPathValidationResult> {
  return fetchJson<MediaPathValidationResult>("/api/intake/media-path/validate", {
    method: "POST",
    body: JSON.stringify({ mediaPath })
  });
}

export function searchPtpMovie(input: { title?: string; mediaPath?: string }): Promise<PtpMovieSearchResponse> {
  return fetchJson<PtpMovieSearchResponse>("/api/intake/ptp-search", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function createManualIntakeJob(input: {
  mediaPath: string;
  releaseName: string;
  ptpTarget: ManualIntakePtpTarget;
  torrentFile?: File | null;
  torrentUrl?: string;
}): Promise<{ job: ApiJob }> {
  const form = new FormData();
  form.set("mediaPath", input.mediaPath);
  form.set("releaseName", input.releaseName);
  form.set("ptpTarget", JSON.stringify(input.ptpTarget));
  if (input.torrentFile) form.set("torrent", input.torrentFile);
  if (input.torrentUrl) form.set("torrentUrl", input.torrentUrl);
  return fetchJson<{ job: ApiJob }>("/api/intake/jobs", { method: "POST", body: form });
}
```

- [ ] **Step 5: Create NewJobPage component**

Create `apps/web/src/components/NewJobPage.tsx` with this public API:

```tsx
import { FileUp, Link2, Search, UploadCloud } from "lucide-react";
import { useMemo, useState } from "react";
import { createManualIntakeJob, searchPtpMovie, validateMediaPath } from "../api.js";
import type { ApiJob, ManualIntakePtpTarget, MediaPathValidationResult, PtpMovieSearchCandidate } from "../types.js";

interface NewJobPageProps {
  onCreated(job: ApiJob): void;
  onStatus(status: { tone: "success" | "error" | "info"; text: string }): void;
}

export function NewJobPage({ onCreated, onStatus }: NewJobPageProps) {
  const [mediaPath, setMediaPath] = useState("");
  const [validation, setValidation] = useState<MediaPathValidationResult | null>(null);
  const [torrentMode, setTorrentMode] = useState<"file" | "url">("file");
  const [torrentFile, setTorrentFile] = useState<File | null>(null);
  const [torrentUrl, setTorrentUrl] = useState("");
  const [releaseName, setReleaseName] = useState("");
  const [searchResults, setSearchResults] = useState<PtpMovieSearchCandidate[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<ManualIntakePtpTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const hasTorrent = torrentMode === "file" ? Boolean(torrentFile) : torrentUrl.trim().length > 0;
  const canCreate = Boolean(validation?.ok && releaseName.trim() && hasTorrent && selectedTarget && !busy);

  async function handleValidate() {
    setBusy(true);
    try {
      const result = await validateMediaPath(mediaPath);
      setValidation(result);
      if (result.ok && !releaseName.trim()) setReleaseName(result.basename.replace(/\.[^.]+$/, ""));
      onStatus({ tone: result.ok ? "success" : "error", text: result.ok ? "Media path validated" : result.error ?? "Invalid media path" });
    } finally {
      setBusy(false);
    }
  }

  async function handleSearch() {
    setBusy(true);
    try {
      const result = await searchPtpMovie({ title: releaseName, mediaPath });
      setSearchResults(result.results);
      setSelectedTarget(null);
      onStatus({ tone: result.results.length ? "success" : "info", text: result.results.length ? "PTP results loaded" : "No PTP movies found" });
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    if (!selectedTarget) return;
    setBusy(true);
    try {
      const result = await createManualIntakeJob({
        mediaPath,
        releaseName,
        ptpTarget: selectedTarget,
        torrentFile,
        torrentUrl: torrentMode === "url" ? torrentUrl : undefined
      });
      onCreated(result.job);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="new-job-page">
      <h1>New Job</h1>
      <label>
        <span>Server media path</span>
        <input value={mediaPath} onChange={(event) => setMediaPath(event.target.value)} />
      </label>
      <button type="button" onClick={handleValidate} disabled={busy || !mediaPath.trim()}>Validate path</button>
      {validation ? <p>{validation.ok ? validation.basename : validation.error}</p> : null}
      <div className="segmented" role="group" aria-label="Torrent source">
        <button type="button" className={torrentMode === "file" ? "active" : undefined} onClick={() => setTorrentMode("file")}>Upload file</button>
        <button type="button" className={torrentMode === "url" ? "active" : undefined} onClick={() => setTorrentMode("url")}>Torrent URL</button>
      </div>
      {torrentMode === "file" ? (
        <input name="torrent" type="file" accept=".torrent,application/x-bittorrent" onChange={(event) => setTorrentFile(event.target.files?.[0] ?? null)} />
      ) : (
        <label>
          <span>Torrent URL</span>
          <input value={torrentUrl} onChange={(event) => setTorrentUrl(event.target.value)} />
        </label>
      )}
      <label>
        <span>Release name</span>
        <input value={releaseName} onChange={(event) => setReleaseName(event.target.value)} />
      </label>
      <button type="button" onClick={handleSearch} disabled={busy || !releaseName.trim()}>Search PTP Movie</button>
      <div className="ptp-result-list">
        {searchResults.map((result) => (
          <div className={`ptp-result ${selectedTarget?.groupId === result.groupId ? "selected-target" : ""}`} key={result.groupId}>
            <a href={result.ptpUrl} target="_blank" rel="noreferrer">{result.displayTitle}</a>
            <button type="button" onClick={() => setSelectedTarget(result)}>Confirm</button>
          </div>
        ))}
      </div>
      {selectedTarget ? <p>PTP Target Confirmed: <a href={selectedTarget.ptpUrl}>{selectedTarget.displayTitle}</a></p> : null}
      <button type="button" onClick={handleCreate} disabled={!canCreate}>Create Job</button>
    </section>
  );
}
```

Fill the component with controlled inputs. Use these labels exactly because the Playwright test relies on them:

- `Server media path`
- `Validate path`
- `Upload file`
- `Torrent URL`
- `Release name`
- `Search PTP Movie`
- `Create Job`

Compute `canCreate`:

```ts
const hasTorrent = torrentMode === "file" ? Boolean(torrentFile) : torrentUrl.trim().length > 0;
const canCreate = Boolean(validation?.ok && releaseName.trim() && hasTorrent && selectedTarget && !busy);
```

When `Validate path` succeeds and `releaseName` is empty, set `releaseName` from `validation.basename` without the final extension.

When a user confirms a result, store the entire `PtpMovieSearchCandidate` as the target.

- [ ] **Step 6: Wire App navigation**

Modify `apps/web/src/App.tsx`:

```ts
import { Activity, FilePlus2, Pause, Play, RefreshCcw, Search, SlidersHorizontal } from "lucide-react";
import { NewJobPage } from "./components/NewJobPage.js";

type ActiveView = "jobs" | "new-job" | "diagnostics";
```

Add sidebar and mobile links named `New Job`.

Add handler:

```ts
const handleManualJobCreated = useCallback((job: ApiJob) => {
  setJobs((current) => [withLocalDraft(job), ...current.filter((item) => item.id !== job.id)]);
  setSelectedJobId(job.id);
  setActiveView("jobs");
  setStatus({ tone: "success", text: `Created job: ${job.id}` });
}, [withLocalDraft]);
```

Render:

```tsx
{activeView === "jobs" ? (
  <QueueTable ... />
) : activeView === "new-job" ? (
  <NewJobPage onCreated={handleManualJobCreated} onStatus={setStatus} />
) : (
  <DiagnosticsPanel ... />
)}
```

Only render the job drawer when `activeView === "jobs"`.

- [ ] **Step 7: Add styles**

Append to `apps/web/src/styles.css`:

```css
.new-job-page {
  display: grid;
  gap: 16px;
  max-width: 980px;
}

.intake-section {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  background: #fff;
}

.intake-grid {
  display: grid;
  gap: 12px;
}

.segmented {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #f6f6f6;
}

.segmented button.active {
  background: #242424;
  color: #fff;
}

.ptp-result-list {
  display: grid;
  gap: 8px;
}

.ptp-result {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}

.selected-target {
  border-color: #8bb7e8;
  background: #f3f8fc;
}
```

Use `--border`, which already exists in `apps/web/src/styles.css`.

- [ ] **Step 8: Document manual testing**

Add to `docs/manual-testing.md`:

```md
### Manual New Job Intake

1. Set `POPCORN_QUEUE_MEDIA_ROOTS=/home/emt/data` in `.env`.
2. Start API and web.
3. Open `New Job`.
4. Enter a movie file under `/home/emt/data`.
5. Upload a `.torrent` or paste a torrent URL.
6. Search PTP, open the result link if needed, confirm the correct movie group, and create the job.
7. Confirm the job appears in `Jobs` and reaches review without waiting for qB download.
```

- [ ] **Step 9: Verify web task**

Run:

```bash
npm run test:e2e -- --project=chromium-desktop apps/web/e2e/ui.spec.ts
npm --workspace @popcorn-queue/web run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/api.ts apps/web/src/components/NewJobPage.tsx apps/web/src/App.tsx apps/web/src/styles.css apps/web/e2e/ui.spec.ts docs/manual-testing.md
git commit -m "feat(web): add manual new job page"
```

---

### Task 5: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run full unit suite**

```bash
npm test
```

Expected: all Vitest files pass.

- [ ] **Step 2: Run full typecheck**

```bash
npm run typecheck
```

Expected: all workspace typechecks pass.

- [ ] **Step 3: Run desktop Playwright coverage**

```bash
npm run test:e2e -- --project=chromium-desktop
```

Expected: desktop Playwright tests pass.

- [ ] **Step 4: Commit verification fixes**

Inspect status after verification. If verification required fixes, commit the touched files:

```bash
git status --short
git add -A
git commit -m "test: stabilize manual intake workflow"
```

If no fixes were required, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage: the plan covers left navigation, media path validation, torrent upload, torrent URL download, PTP search, explicit confirmation, job creation, review draft group ID, no qB wait for server media paths, UI errors, and mocked tests.
- Network isolation: API tests mock PTP through `PtpClient.prototype.searchByCandidate`, torrent URL downloads through `fetchImpl`, and qB through fake `TorrentDownloadClient`.
- Type consistency: `ManualIntakePtpTarget`, `MediaPathValidationResult`, and `PtpMovieSearchResponse` are defined in core and mirrored in web.
- Persistence: manual intake metadata is stored in `job.source`, which is already JSON-persisted, so no Prisma schema migration is needed.
