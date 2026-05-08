# qBittorrent Realtime Download Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show live qBittorrent download progress in the job queue and selected-job review panel while keeping qB access backend-only.

**Architecture:** Add a shared `DownloadStatus` contract in `@popcorn-queue/core`, teach the qB client to return structured torrent status, and have the worker report status snapshots through the API-owned phase context. Persist the latest snapshot on each job, return it from existing job APIs, and render compact queue progress plus detailed selected-job download information.

**Tech Stack:** TypeScript, npm workspaces, Fastify, Prisma SQLite, Vitest, React/Vite, Playwright.

---

## File Structure

- Create `packages/core/src/download-status.ts`: shared status type, complete-state helper, and error-status helper.
- Modify `packages/core/src/index.ts`: export the new shared type/helpers.
- Modify `packages/integrations/src/torrent-clients.ts`: add `getStatus(infoHash)` to the torrent client interface and qB implementation.
- Modify `packages/integrations/src/torrent-clients.test.ts`: mock qB status responses and HTTP 401 failures.
- Modify `apps/worker/src/phases.ts`: add status reporting to `PhaseContext`, wait loop, and `download-or-locate` error paths.
- Modify `apps/worker/src/phases.test.ts`: test staged qB progress callbacks without real qB.
- Modify `apps/api/src/jobs.ts`: add `downloadStatus` to `Job` and `updateDownloadStatus()`.
- Modify `apps/api/src/persistence.ts`: serialize, deserialize, and persist the new job field.
- Modify `apps/api/prisma/schema.prisma`: add `download_status` mapped field.
- Create `apps/api/src/persistence.test.ts`: verify SQLite persistence of `downloadStatus`.
- Modify `apps/api/src/preparation.ts`: inject `reportDownloadStatus`, update jobs, and throttle job-log status lines.
- Modify `apps/api/src/preparation.test.ts`: verify fake qB progress appears on the job and logs are throttled.
- Modify `apps/api/src/server.ts`: return `/api/jobs/:id/download-status` for debugging.
- Modify `apps/api/src/server.test.ts`: verify the debug endpoint response.
- Modify `apps/web/src/types.ts`: add `DownloadStatus` to `ApiJob`.
- Create `apps/web/src/download-status.ts`: UI formatting helpers.
- Create `apps/web/src/download-status.test.ts`: pure Vitest coverage for queue labels and formatting.
- Modify `apps/web/src/App.tsx`: poll dashboard data every 3 seconds.
- Modify `apps/web/src/components/QueueTable.tsx`: add compact `Download` column.
- Modify `apps/web/src/components/ReviewPanel.tsx`: add selected-job `Download` section.
- Modify `apps/web/src/styles.css`: add progress bar and download detail styles.
- Modify `apps/web/e2e/ui.spec.ts`: mock download status and assert the queue column and detail section render.

---

### Task 1: Shared Download Status And qB Client Parsing

**Files:**
- Create: `packages/core/src/download-status.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/integrations/src/torrent-clients.ts`
- Test: `packages/integrations/src/torrent-clients.test.ts`

- [ ] **Step 1: Write failing qB status tests**

Append these tests inside `describe("QBittorrentClient", () => { ... })` in `packages/integrations/src/torrent-clients.test.ts`:

```ts
  it("reads qBittorrent torrent status without external network", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      if (String(input).includes("/api/v2/auth/login")) return new Response("Ok.", { status: 200, headers: { "set-cookie": "SID=abc" } });
      if (String(input).includes("/api/v2/torrents/info")) {
        return Response.json([
          {
            hash: "ABC123",
            state: "downloading",
            progress: 0.42,
            downloaded: 4_200,
            size: 10_000,
            amount_left: 5_800,
            dlspeed: 8_388_608,
            upspeed: 1024,
            eta: 720,
            num_seeds: 12,
            num_leechs: 3,
            save_path: "/downloads",
            content_path: "/downloads/Movie.mkv"
          }
        ]);
      }
      return new Response("Not found", { status: 404 });
    };

    const client = new QBittorrentClient({
      baseUrl: "127.0.0.1:10049",
      username: "user",
      password: "pass",
      fetchImpl
    });

    await expect(client.getStatus("ABC123")).resolves.toMatchObject({
      client: "qbittorrent",
      infoHash: "ABC123",
      state: "downloading",
      progress: 0.42,
      downloaded: 4_200,
      size: 10_000,
      amountLeft: 5_800,
      downloadSpeed: 8_388_608,
      uploadSpeed: 1024,
      eta: 720,
      seeds: 12,
      peers: 3,
      savePath: "/downloads",
      contentPath: "/downloads/Movie.mkv",
      error: null
    });
    expect(calls[1]).toBe("http://127.0.0.1:10049/api/v2/torrents/info?hashes=ABC123");
  });

  it("reports missing qBittorrent torrents as missing status", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("/api/v2/auth/login")) return new Response("Ok.", { status: 200, headers: { "set-cookie": "SID=abc" } });
      if (String(input).includes("/api/v2/torrents/info")) return Response.json([]);
      return new Response("Not found", { status: 404 });
    };
    const client = new QBittorrentClient({ baseUrl: "127.0.0.1:10049", username: "user", password: "pass", fetchImpl });

    await expect(client.getStatus("MISSING")).resolves.toMatchObject({
      client: "qbittorrent",
      infoHash: "MISSING",
      state: "missing",
      progress: null,
      error: "Torrent is not present in qBittorrent."
    });
  });

  it("surfaces qBittorrent status HTTP failures", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("/api/v2/auth/login")) return new Response("Ok.", { status: 200, headers: { "set-cookie": "SID=abc" } });
      return new Response("Unauthorized", { status: 401 });
    };
    const client = new QBittorrentClient({ baseUrl: "127.0.0.1:10049", username: "user", password: "pass", fetchImpl });

    await expect(client.getStatus("ABC123")).rejects.toThrow("qBittorrent torrent status lookup failed with HTTP 401.");
  });
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
npm test -- packages/integrations/src/torrent-clients.test.ts
```

Expected: FAIL with TypeScript/runtime errors because `getStatus` and shared status helpers are not defined.

- [ ] **Step 3: Add shared status type and helpers**

Create `packages/core/src/download-status.ts`:

```ts
export interface DownloadStatus {
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

const COMPLETE_STATES = new Set(["uploading", "stalledUP", "queuedUP", "pausedUP", "forcedUP", "checkingUP"]);

export function isDownloadComplete(status: Pick<DownloadStatus, "progress" | "state">): boolean {
  return status.progress === 1 || COMPLETE_STATES.has(status.state);
}

export function createDownloadStatus(input: Omit<DownloadStatus, "lastUpdatedAt"> & { lastUpdatedAt?: string }): DownloadStatus {
  return {
    ...input,
    lastUpdatedAt: input.lastUpdatedAt ?? new Date().toISOString()
  };
}

export function createDownloadErrorStatus(input: {
  client: DownloadStatus["client"];
  infoHash: string | null;
  state?: string;
  error: string;
  lastUpdatedAt?: string;
}): DownloadStatus {
  return createDownloadStatus({
    client: input.client,
    infoHash: input.infoHash,
    state: input.state ?? "error",
    progress: null,
    downloaded: null,
    size: null,
    amountLeft: null,
    downloadSpeed: null,
    uploadSpeed: null,
    eta: null,
    seeds: null,
    peers: null,
    savePath: null,
    contentPath: null,
    error: input.error,
    ...(input.lastUpdatedAt ? { lastUpdatedAt: input.lastUpdatedAt } : {})
  });
}
```

Modify `packages/core/src/index.ts`:

```ts
export * from "./cache.js";
export * from "./download-status.js";
export * from "./parse.js";
export * from "./ptp-normalize.js";
export * from "./media.js";
export * from "./metadata.js";
export * from "./ptp-upload-rules.js";
export * from "./release.js";
export * from "./rules.js";
export * from "./scene.js";
export * from "./screenshots.js";
export * from "./types.js";
export * from "./torrent-reuse.js";
export * from "./upload-plan.js";
export * from "./upload-readiness.js";
export * from "./workspace.js";
export * from "./log-redaction.js";
```

- [ ] **Step 4: Implement qB status parsing**

Modify the imports and interfaces in `packages/integrations/src/torrent-clients.ts`:

```ts
import { createDownloadErrorStatus, createDownloadStatus, isDownloadComplete, type DownloadStatus } from "@popcorn-queue/core";

export interface TorrentClient {
  readonly name: string;
  addTorrent(options: TorrentClientAddOptions): Promise<{ infoHash: string }>;
  getStatus(infoHash: string): Promise<DownloadStatus>;
  isComplete(infoHash: string): Promise<boolean>;
  listFiles(infoHash: string): Promise<TorrentClientFile[]>;
  removeTorrent(infoHash: string, options?: { deleteData?: boolean }): Promise<void>;
}
```

Extend `NotConfiguredTorrentClient`:

```ts
  async getStatus(infoHash: string): Promise<DownloadStatus> {
    return createDownloadErrorStatus({
      client: this.name,
      infoHash: infoHash || null,
      state: "unavailable",
      error: "Torrent client is not configured."
    });
  }
```

Replace `QBittorrentTorrentInfo` with:

```ts
interface QBittorrentTorrentInfo {
  hash?: string;
  state?: string;
  progress?: number;
  downloaded?: number;
  size?: number;
  total_size?: number;
  amount_left?: number;
  dlspeed?: number;
  dl_speed?: number;
  upspeed?: number;
  up_speed?: number;
  eta?: number;
  num_seeds?: number;
  num_leechs?: number;
  save_path?: string;
  content_path?: string;
}
```

Add these methods to `QBittorrentClient`:

```ts
  async getStatus(infoHash: string): Promise<DownloadStatus> {
    if (!infoHash) {
      return createDownloadErrorStatus({
        client: this.name,
        infoHash: null,
        state: "missing",
        error: "Torrent info hash is missing."
      });
    }
    await this.login();
    const response = await this.fetchImpl(this.url(`/api/v2/torrents/info?hashes=${encodeURIComponent(infoHash)}`), this.cookie ? { headers: { cookie: this.cookie } } : undefined);
    if (!response.ok) throw new Error(`qBittorrent torrent status lookup failed with HTTP ${response.status}.`);
    const torrents = (await response.json()) as QBittorrentTorrentInfo[];
    const torrent = Array.isArray(torrents) ? torrents[0] : undefined;
    if (!torrent) {
      return createDownloadErrorStatus({
        client: this.name,
        infoHash,
        state: "missing",
        error: "Torrent is not present in qBittorrent."
      });
    }

    return createDownloadStatus({
      client: this.name,
      infoHash: typeof torrent.hash === "string" && torrent.hash ? torrent.hash : infoHash,
      state: typeof torrent.state === "string" && torrent.state ? torrent.state : "unknown",
      progress: numberOrNull(torrent.progress),
      downloaded: numberOrNull(torrent.downloaded),
      size: numberOrNull(torrent.size ?? torrent.total_size),
      amountLeft: numberOrNull(torrent.amount_left),
      downloadSpeed: numberOrNull(torrent.dlspeed ?? torrent.dl_speed),
      uploadSpeed: numberOrNull(torrent.upspeed ?? torrent.up_speed),
      eta: numberOrNull(torrent.eta),
      seeds: numberOrNull(torrent.num_seeds),
      peers: numberOrNull(torrent.num_leechs),
      savePath: stringOrNull(torrent.save_path),
      contentPath: stringOrNull(torrent.content_path),
      error: null
    });
  }
```

Add helpers near the existing private parsing helpers:

```ts
function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
```

Replace `isComplete()` with:

```ts
  async isComplete(infoHash: string): Promise<boolean> {
    return isDownloadComplete(await this.getStatus(infoHash));
  }
```

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm test -- packages/integrations/src/torrent-clients.test.ts
npm --workspace @popcorn-queue/core run typecheck
npm --workspace @popcorn-queue/integrations run typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/core/src/download-status.ts packages/core/src/index.ts packages/integrations/src/torrent-clients.ts packages/integrations/src/torrent-clients.test.ts
git commit -m "feat(integrations): expose qb download status"
```

---

### Task 2: Worker Download Status Reporting

**Files:**
- Modify: `apps/worker/src/phases.ts`
- Test: `apps/worker/src/phases.test.ts`

- [ ] **Step 1: Write failing worker status callback test**

Append this test to `apps/worker/src/phases.test.ts` inside `describe("worker phase scaffold", () => { ... })`:

```ts
  it("reports qBittorrent download progress while waiting for completion", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-worker-qb-status-"));
    const torrentPath = path.join(tempDir, "source.torrent");
    const downloadDir = path.join(tempDir, "download");
    const mediaPath = path.join(downloadDir, "Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await mkdir(downloadDir, { recursive: true });
    await writeFile(torrentPath, "source torrent");
    await writeFile(mediaPath, "movie");
    const reported: Array<{ state: string; progress: number | null }> = [];
    const statuses = [
      { state: "downloading", progress: 0, downloaded: 0, size: 5, amountLeft: 5 },
      { state: "downloading", progress: 0.5, downloaded: 3, size: 5, amountLeft: 2 },
      { state: "uploading", progress: 1, downloaded: 5, size: 5, amountLeft: 0 }
    ];
    const download = createDefaultPhaseHandlers().find((handler): handler is PhaseHandler<"download-or-locate"> => handler.phase === "download-or-locate");
    if (!download) throw new Error("Missing download-or-locate handler");

    const context = createPhaseContext(
      "job-qb-status",
      {
        candidate,
        sourceTorrentPath: torrentPath,
        workingDirectory: tempDir
      },
      {
        torrentClientOptions: { waitTimeoutMs: 500, waitIntervalMs: 1 },
        torrentClient: {
          name: "mock-qb",
          async addTorrent() {
            return { infoHash: "ABC123" };
          },
          async getStatus(infoHash) {
            const next = statuses.shift() ?? { state: "uploading", progress: 1, downloaded: 5, size: 5, amountLeft: 0 };
            return {
              client: "mock-qb",
              infoHash,
              state: next.state,
              progress: next.progress,
              downloaded: next.downloaded,
              size: next.size,
              amountLeft: next.amountLeft,
              downloadSpeed: next.progress === 1 ? 0 : 1024,
              uploadSpeed: 0,
              eta: next.progress === 1 ? 0 : 10,
              seeds: 2,
              peers: 1,
              savePath: downloadDir,
              contentPath: mediaPath,
              lastUpdatedAt: "2026-05-08T00:00:00.000Z",
              error: null
            };
          },
          async isComplete() {
            throw new Error("isComplete should be implemented through getStatus in the worker wait loop.");
          },
          async listFiles() {
            return [{ name: path.basename(mediaPath), size: 5, progress: 1 }];
          }
        },
        reportDownloadStatus: async (status) => {
          reported.push({ state: status.state, progress: status.progress });
        }
      }
    );

    const output = await download.run(context);

    expect(output.status).toBe("completed");
    expect(output.infoHash).toBe("ABC123");
    expect(reported).toEqual([
      { state: "downloading", progress: 0 },
      { state: "downloading", progress: 0.5 },
      { state: "uploading", progress: 1 }
    ]);
  });
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
npm test -- apps/worker/src/phases.test.ts
```

Expected: FAIL because `TorrentDownloadClient.getStatus` and `reportDownloadStatus` do not exist.

- [ ] **Step 3: Extend worker phase context types**

Modify the import from core in `apps/worker/src/phases.ts`:

```ts
  type DownloadStatus,
  isDownloadComplete,
  createDownloadErrorStatus,
```

Update `TorrentDownloadClient`:

```ts
export interface TorrentDownloadClient {
  readonly name: string;
  addTorrent(options: { torrentPath: string; downloadPath: string; category?: string; tags?: string[]; skipHashCheck?: boolean }): Promise<{ infoHash: string }>;
  getStatus(infoHash: string): Promise<DownloadStatus>;
  isComplete(infoHash: string): Promise<boolean>;
  listFiles(infoHash: string): Promise<TorrentClientFile[]>;
}
```

Update `PhaseContext`:

```ts
  reportDownloadStatus(status: DownloadStatus): Promise<void>;
```

Update `CreatePhaseContextOptions`:

```ts
  reportDownloadStatus?: (status: DownloadStatus) => Promise<void>;
```

Update `createPhaseContext()` return object:

```ts
    reportDownloadStatus: options.reportDownloadStatus ?? (async () => undefined),
```

- [ ] **Step 4: Replace the wait loop with status reporting**

Replace `waitForTorrentComplete()` in `apps/worker/src/phases.ts`:

```ts
async function waitForTorrentComplete(context: PhaseContext, infoHash: string): Promise<boolean> {
  const deadline = Date.now() + context.torrentClientOptions.waitTimeoutMs;
  do {
    const status = await context.torrentClient!.getStatus(infoHash);
    await context.reportDownloadStatus(status);
    if (isDownloadComplete(status)) return true;
    if (context.torrentClientOptions.waitTimeoutMs <= 0 || Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, context.torrentClientOptions.waitIntervalMs));
  } while (Date.now() < deadline);
  return false;
}
```

In `download-or-locate`, report unavailable and missing states before skipped returns:

```ts
        if (!context.torrentClient) {
          await context.reportDownloadStatus(createDownloadErrorStatus({
            client: "not-configured",
            infoHash: null,
            state: "unavailable",
            error: "Torrent client integration is not configured."
          }));
          return {
            ...base("skipped", "Torrent client integration is not configured in this worker scaffold."),
            sourceUrl: context.job.candidate.sourceUrl ?? null,
            downloadUrl: context.job.candidate.downloadUrl ?? null,
            filePath: null,
            downloadDirectory,
            infoHash: null,
            client: null
          };
        }
```

```ts
        if (!torrentPath || !(await pathExists(torrentPath))) {
          await context.reportDownloadStatus(createDownloadErrorStatus({
            client: context.torrentClient.name,
            infoHash: null,
            state: "missing",
            error: "Source torrent file is missing."
          }));
          return {
            ...base("skipped", "Source torrent file is missing."),
            sourceUrl: context.job.candidate.sourceUrl ?? null,
            downloadUrl: context.job.candidate.downloadUrl ?? null,
            filePath: null,
            downloadDirectory,
            infoHash: null,
            client: context.torrentClient.name
          };
        }
```

Wrap the qB add/wait/list part in a `try/catch` so qB auth and lookup errors become a failed phase with a visible status:

```ts
        try {
          await mkdir(downloadDirectory, { recursive: true });
          const addOptions: Parameters<TorrentDownloadClient["addTorrent"]>[0] = {
            torrentPath,
            downloadPath: downloadDirectory
          };
          if (context.torrentClientOptions.category) addOptions.category = context.torrentClientOptions.category;
          if (context.torrentClientOptions.tags?.length) addOptions.tags = context.torrentClientOptions.tags;
          const { infoHash } = await context.torrentClient.addTorrent(addOptions);
          const complete = await waitForTorrentComplete(context, infoHash);
          if (!complete) {
            return {
              ...base("blocked", "Torrent is still downloading."),
              sourceUrl: context.job.candidate.sourceUrl ?? null,
              downloadUrl: context.job.candidate.downloadUrl ?? null,
              filePath: null,
              downloadDirectory,
              infoHash,
              client: context.torrentClient.name
            };
          }

          const files = await context.torrentClient.listFiles(infoHash);
          const mainFile = selectMainMediaFile(files);
          const filePath = mainFile ? path.join(downloadDirectory, mainFile.name) : null;
          return {
            ...base(filePath && (await pathExists(filePath)) ? "completed" : "blocked", filePath ? "Downloaded media located." : "No media file was found in torrent contents."),
            sourceUrl: context.job.candidate.sourceUrl ?? null,
            downloadUrl: context.job.candidate.downloadUrl ?? null,
            filePath,
            downloadDirectory,
            infoHash,
            client: context.torrentClient.name
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await context.reportDownloadStatus(createDownloadErrorStatus({
            client: context.torrentClient.name,
            infoHash: null,
            state: "error",
            error: message
          }));
          return {
            ...base("failed", message),
            sourceUrl: context.job.candidate.sourceUrl ?? null,
            downloadUrl: context.job.candidate.downloadUrl ?? null,
            filePath: null,
            downloadDirectory,
            infoHash: null,
            client: context.torrentClient.name
          };
        }
```

- [ ] **Step 5: Update existing fake torrent clients**

Every fake `torrentClient` in `apps/worker/src/phases.test.ts` and `apps/api/src/preparation.test.ts` must include:

```ts
        async getStatus(infoHash) {
          return {
            client: "mock-qb",
            infoHash,
            state: "uploading",
            progress: 1,
            downloaded: 5,
            size: 5,
            amountLeft: 0,
            downloadSpeed: 0,
            uploadSpeed: 0,
            eta: 0,
            seeds: 1,
            peers: 0,
            savePath: null,
            contentPath: null,
            lastUpdatedAt: "2026-05-08T00:00:00.000Z",
            error: null
          };
        },
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
npm test -- apps/worker/src/phases.test.ts apps/api/src/preparation.test.ts
npm --workspace @popcorn-queue/worker run typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/worker/src/phases.ts apps/worker/src/phases.test.ts apps/api/src/preparation.test.ts
git commit -m "feat(worker): report torrent download progress"
```

---

### Task 3: Job Repository And SQLite Persistence

**Files:**
- Modify: `apps/api/src/jobs.ts`
- Modify: `apps/api/src/persistence.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Test: `apps/api/src/jobs.test.ts`
- Create: `apps/api/src/persistence.test.ts`

- [ ] **Step 1: Write failing repository tests**

Append this test to `apps/api/src/jobs.test.ts`:

```ts
  it("stores latest download status without adding noisy job events", () => {
    const repo = new JobRepository();
    let job = repo.create({ candidate });
    const eventCount = job.events.length;

    job = repo.updateDownloadStatus(job.id, {
      client: "qbittorrent",
      infoHash: "ABC123",
      state: "downloading",
      progress: 0.42,
      downloaded: 4_200,
      size: 10_000,
      amountLeft: 5_800,
      downloadSpeed: 8_388_608,
      uploadSpeed: 0,
      eta: 720,
      seeds: 12,
      peers: 3,
      savePath: "/downloads",
      contentPath: "/downloads/Movie.mkv",
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      error: null
    })!;

    expect(job.downloadStatus).toMatchObject({ infoHash: "ABC123", progress: 0.42 });
    expect(job.events).toHaveLength(eventCount);
  });
```

Create `apps/api/src/persistence.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrismaPersistence } from "./persistence.js";

const candidate = {
  site: "mteam" as const,
  title: "Movie.2024.1080p.BluRay.x264-GROUP",
  imdbId: "tt1234567"
};

let previousDatabaseUrl: string | undefined;

afterEach(() => {
  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

describe("Prisma job persistence", () => {
  it("persists download status snapshots", async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-prisma-status-"));
    process.env.DATABASE_URL = `file:${path.join(dataDir, "jobs.db")}`;
    const persistence = new PrismaPersistence();
    try {
      const job = await persistence.jobs.create({ candidate });
      await persistence.jobs.updateDownloadStatus(job.id, {
        client: "qbittorrent",
        infoHash: "ABC123",
        state: "downloading",
        progress: 0.42,
        downloaded: 4_200,
        size: 10_000,
        amountLeft: 5_800,
        downloadSpeed: 8_388_608,
        uploadSpeed: 0,
        eta: 720,
        seeds: 12,
        peers: 3,
        savePath: "/downloads",
        contentPath: "/downloads/Movie.mkv",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        error: null
      });

      const loaded = await persistence.jobs.get(job.id);
      expect(loaded?.downloadStatus).toMatchObject({
        client: "qbittorrent",
        infoHash: "ABC123",
        state: "downloading",
        progress: 0.42
      });
    } finally {
      await persistence.disconnect();
    }
  });
});
```

- [ ] **Step 2: Run failing repository tests**

Run:

```bash
npm --workspace @popcorn-queue/api run prisma:generate
npm test -- apps/api/src/jobs.test.ts apps/api/src/persistence.test.ts
```

Expected: FAIL because `downloadStatus`, `updateDownloadStatus`, and the Prisma mapped field do not exist.

- [ ] **Step 3: Add job type and in-memory repository method**

Modify the imports in `apps/api/src/jobs.ts`:

```ts
  type DownloadStatus,
```

Add `downloadStatus?: DownloadStatus;` to `Job`.

Add this method to `JobRepository`:

```ts
  updateDownloadStatus(id: string, status: DownloadStatus): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.downloadStatus = status;
    job.updatedAt = nowIso();
    return job;
  }
```

- [ ] **Step 4: Persist the new JSON column**

Modify `apps/api/prisma/schema.prisma` inside `model Job`:

```prisma
  downloadStatusJson String?  @map("download_status")
```

Modify `apps/api/src/persistence.ts` `JobRow`:

```ts
  downloadStatusJson: string | null;
```

Modify `serializeJob(job)`:

```ts
    downloadStatusJson: stringifyOptional(job.downloadStatus),
```

Modify `deserializeJob(row)` after workspace parsing:

```ts
  const downloadStatus = parseOptionalJson<Job["downloadStatus"]>(row.downloadStatusJson);
  if (downloadStatus !== undefined) job.downloadStatus = downloadStatus;
```

Modify `createTables()` raw SQL after `"workspace" TEXT,`:

```sql
        "download_status" TEXT,
```

Add the migration helper call after workspace:

```ts
    await this.addColumnIfMissing("Job", "download_status", "TEXT");
```

Add this method to `PrismaJobRepository`:

```ts
  async updateDownloadStatus(id: string, status: DownloadStatus): Promise<Job | null> {
    return this.withJob(id, (repo) => repo.updateDownloadStatus(id, status));
  }
```

Add `type DownloadStatus` to the core import in `persistence.ts`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm --workspace @popcorn-queue/api run prisma:generate
npm test -- apps/api/src/jobs.test.ts apps/api/src/persistence.test.ts
npm --workspace @popcorn-queue/api run typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/api/src/jobs.ts apps/api/src/jobs.test.ts apps/api/src/persistence.ts apps/api/src/persistence.test.ts apps/api/prisma/schema.prisma
git commit -m "feat(api): persist job download status"
```

---

### Task 4: Preparation Service Wiring, Log Throttling, And Status Endpoint

**Files:**
- Modify: `apps/api/src/preparation.ts`
- Modify: `apps/api/src/preparation.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`

- [ ] **Step 1: Write failing preparation and endpoint tests**

Append this test to `apps/api/src/preparation.test.ts`:

```ts
  it("stores qBittorrent progress snapshots and throttles readable download logs", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-prep-status-"));
    const jobs = new JobRepository();
    const sourceTorrentPath = path.join(dataRoot, "jobs", "source.torrent");
    await mkdir(path.dirname(sourceTorrentPath), { recursive: true });
    await writeFile(sourceTorrentPath, "source torrent");
    const job = jobs.create({
      candidate: {
        site: "pter",
        title: "Movie.2024.1080p.WEB-DL.x265-GROUP",
        imdbId: "tt1234567"
      },
      torrent: {
        filename: "source.torrent",
        bytes: 13,
        filePath: sourceTorrentPath
      }
    });
    const statuses = [0, 0.01, 0.049, 0.05, 0.099, 0.10, 1];
    const service = new PreparationService({
      dataRoot,
      jobs,
      runExternalTools: false,
      toolCommands: { ffmpeg: "ffmpeg", mediainfo: "mediainfo", oxipng: "oxipng" },
      torrentClientOptions: { waitTimeoutMs: 1000, waitIntervalMs: 1 },
      torrentClient: {
        name: "mock-qb",
        async addTorrent(options) {
          await mkdir(options.downloadPath, { recursive: true });
          await writeFile(path.join(options.downloadPath, "Movie.2024.1080p.WEB-DL.x265-GROUP.mkv"), "movie");
          return { infoHash: "ABC123" };
        },
        async getStatus(infoHash) {
          const progress = statuses.shift() ?? 1;
          return {
            client: "mock-qb",
            infoHash,
            state: progress === 1 ? "uploading" : "downloading",
            progress,
            downloaded: Math.round(progress * 10_000),
            size: 10_000,
            amountLeft: Math.round((1 - progress) * 10_000),
            downloadSpeed: progress === 1 ? 0 : 1024,
            uploadSpeed: 0,
            eta: progress === 1 ? 0 : 60,
            seeds: 2,
            peers: 1,
            savePath: null,
            contentPath: null,
            lastUpdatedAt: "2026-05-08T00:00:00.000Z",
            error: null
          };
        },
        async isComplete() {
          return false;
        },
        async listFiles() {
          return [{ name: "Movie.2024.1080p.WEB-DL.x265-GROUP.mkv", size: 10_000, progress: 1 }];
        }
      }
    });

    await service.runJob(job.id);
    const prepared = jobs.get(job.id)!;
    const logText = await readFile(path.join(dataRoot, "jobs", job.id, "logs", "job.log"), "utf8");

    expect(prepared.downloadStatus).toMatchObject({ infoHash: "ABC123", state: "uploading", progress: 1 });
    expect(logText.match(/Download progress/g)?.length ?? 0).toBeLessThanOrEqual(4);
    expect(logText).toContain("Download progress: 0%");
    expect(logText).toContain("Download progress: 5%");
    expect(logText).toContain("Download progress: 10%");
    expect(logText).toContain("Download complete.");
  });
```

Add `readFile` to the existing `node:fs/promises` import in `apps/api/src/preparation.test.ts` if it is not already imported.

Append this test to `apps/api/src/server.test.ts` in the API jobs describe block:

```ts
  it("returns null download status for jobs without a download snapshot", async () => {
    await withServer(async (app) => {
      const create = await app.inject({
        method: "POST",
        url: "/api/jobs",
        payload: {
          site: "mteam",
          title: "Movie.2024.1080p.BluRay.x264-GROUP",
          imdbId: "tt1234567"
        }
      });
      expect(create.statusCode).toBe(201);
      const job = create.json<{ job: Job }>().job;

      const response = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/download-status` });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ downloadStatus: null });
    });
  });
```

- [ ] **Step 2: Run failing focused tests**

Run:

```bash
npm test -- apps/api/src/preparation.test.ts apps/api/src/server.test.ts
```

Expected: FAIL because preparation does not report status and the endpoint does not exist.

- [ ] **Step 3: Extend preparation store contract**

Modify `apps/api/src/preparation.ts` imports:

```ts
  type DownloadStatus,
```

Update `PreparationJobStore`:

```ts
  updateDownloadStatus(id: string, status: DownloadStatus): MaybePromise<Job | null>;
```

- [ ] **Step 4: Add log throttling helpers**

Add these helpers before `export class PreparationService`:

```ts
interface DownloadLogState {
  lastState: string | null;
  lastBucket: number | null;
  completed: boolean;
  errored: boolean;
}

function progressBucket(status: DownloadStatus): number | null {
  if (typeof status.progress !== "number") return null;
  return Math.floor(Math.max(0, Math.min(1, status.progress)) * 20);
}

function percentLabel(status: DownloadStatus): string {
  if (typeof status.progress !== "number") return "unknown";
  return `${Math.round(Math.max(0, Math.min(1, status.progress)) * 100)}%`;
}

function shouldLogDownloadStatus(status: DownloadStatus, state: DownloadLogState): boolean {
  if (status.error && !state.errored) return true;
  if (status.progress === 1 && !state.completed) return true;
  const bucket = progressBucket(status);
  if (bucket !== null && bucket !== state.lastBucket) return true;
  return status.state !== state.lastState;
}

function downloadLogMessage(status: DownloadStatus): string {
  if (status.error) return `Download error: ${status.error}`;
  if (status.progress === 1) return "Download complete.";
  return `Download progress: ${percentLabel(status)}`;
}

function updateDownloadLogState(status: DownloadStatus, state: DownloadLogState): void {
  state.lastState = status.state;
  state.lastBucket = progressBucket(status);
  state.completed = state.completed || status.progress === 1;
  state.errored = state.errored || Boolean(status.error);
}
```

- [ ] **Step 5: Inject status reporter into phase context**

Inside `runJob()`, before `const contextOptions`, add:

```ts
    const downloadLogState: DownloadLogState = {
      lastState: null,
      lastBucket: null,
      completed: false,
      errored: false
    };
```

Inside `contextOptions`, add:

```ts
      reportDownloadStatus: async (status: DownloadStatus) => {
        await this.options.jobs.updateDownloadStatus(job.id, status);
        if (!shouldLogDownloadStatus(status, downloadLogState)) return;
        await appendJobEvent(paths.logs.jobLog, {
          at: nowIso(),
          level: status.error ? "error" : "info",
          message: downloadLogMessage(status),
          payload: {
            client: status.client,
            infoHash: status.infoHash,
            state: status.state,
            progress: status.progress,
            downloaded: status.downloaded,
            size: status.size,
            amountLeft: status.amountLeft,
            downloadSpeed: status.downloadSpeed,
            eta: status.eta,
            error: status.error
          }
        });
        updateDownloadLogState(status, downloadLogState);
      },
```

- [ ] **Step 6: Add debug endpoint**

Add this route in `apps/api/src/server.ts` after `/api/jobs/:id`:

```ts
  app.get<{ Params: { id: string } }>("/api/jobs/:id/download-status", async (request, reply) => {
    const job = await jobRepository.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    return { downloadStatus: job.downloadStatus ?? null };
  });
```

- [ ] **Step 7: Run tests and commit**

Run:

```bash
npm test -- apps/api/src/preparation.test.ts apps/api/src/server.test.ts
npm --workspace @popcorn-queue/api run typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/api/src/preparation.ts apps/api/src/preparation.test.ts apps/api/src/server.ts apps/api/src/server.test.ts
git commit -m "feat(api): publish job download status"
```

---

### Task 5: Web Formatting Helpers And UI Rendering

**Files:**
- Modify: `apps/web/src/types.ts`
- Create: `apps/web/src/download-status.ts`
- Create: `apps/web/src/download-status.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/QueueTable.tsx`
- Modify: `apps/web/src/components/ReviewPanel.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Write failing web helper tests**

Create `apps/web/src/download-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { downloadDetailRows, downloadQueueLabel, formatBytes, formatEta, formatSpeed } from "./download-status.js";
import type { DownloadStatus } from "./types.js";

const status: DownloadStatus = {
  client: "qbittorrent",
  infoHash: "ABC123",
  state: "downloading",
  progress: 0.42,
  downloaded: 4_200,
  size: 10_000,
  amountLeft: 5_800,
  downloadSpeed: 8_388_608,
  uploadSpeed: 0,
  eta: 720,
  seeds: 12,
  peers: 3,
  savePath: "/downloads",
  contentPath: "/downloads/Movie.mkv",
  lastUpdatedAt: "2026-05-08T00:00:00.000Z",
  error: null
};

describe("download status formatting", () => {
  it("formats bytes, speed, and ETA", () => {
    expect(formatBytes(1_048_576)).toBe("1.0 MB");
    expect(formatSpeed(8_388_608)).toBe("8.0 MB/s");
    expect(formatEta(720)).toBe("12m");
  });

  it("formats compact queue labels", () => {
    expect(downloadQueueLabel(status)).toBe("42% - 8.0 MB/s - 12m");
    expect(downloadQueueLabel({ ...status, state: "queuedDL", progress: 0.12, downloadSpeed: 0, eta: 8640000 })).toBe("Queued - 12%");
    expect(downloadQueueLabel({ ...status, state: "uploading", progress: 1, downloadSpeed: 0, eta: 0 })).toBe("Downloaded");
    expect(downloadQueueLabel({ ...status, state: "error", progress: null, error: "qB auth failed" })).toBe("qB auth failed");
  });

  it("builds selected-job detail rows", () => {
    expect(downloadDetailRows(status)).toContainEqual(["Info hash", "ABC123"]);
    expect(downloadDetailRows(status)).toContainEqual(["Downloaded", "4.1 KB / 9.8 KB"]);
    expect(downloadDetailRows(status)).toContainEqual(["Peers", "12 seeds / 3 peers"]);
  });
});
```

- [ ] **Step 2: Run failing web helper tests**

Run:

```bash
npm test -- apps/web/src/download-status.test.ts
```

Expected: FAIL because helper file and type do not exist.

- [ ] **Step 3: Add web type and helper implementation**

Add to `apps/web/src/types.ts`:

```ts
export interface DownloadStatus {
  client: string;
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

Add `downloadStatus?: DownloadStatus;` to `ApiJob`.

Create `apps/web/src/download-status.ts`:

```ts
import type { DownloadStatus } from "./types.js";

const QUEUED_STATES = new Set(["queuedDL", "queuedUP"]);
const STALLED_STATES = new Set(["stalledDL", "stalledUP"]);
const CHECKING_STATES = new Set(["checkingDL", "checkingUP", "checkingResumeData"]);

export function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(size)} ${units[unit]}` : `${size.toFixed(1)} ${units[unit]}`;
}

export function formatSpeed(value: number | null | undefined): string {
  if (!value) return "-";
  return `${formatBytes(value)}/s`;
}

export function formatEta(value: number | null | undefined): string {
  if (typeof value !== "number" || value < 0 || value === 8640000) return "-";
  if (value === 0) return "now";
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(value)}s`;
}

export function progressPercent(status: DownloadStatus | undefined): number | null {
  if (typeof status?.progress !== "number") return null;
  return Math.round(Math.max(0, Math.min(1, status.progress)) * 100);
}

function stateLabel(state: string): string {
  if (QUEUED_STATES.has(state)) return "Queued";
  if (STALLED_STATES.has(state)) return "Stalled";
  if (CHECKING_STATES.has(state)) return "Checking";
  if (state === "metaDL") return "Metadata";
  if (state === "missing") return "No torrent";
  if (state === "unavailable") return "No qB";
  if (state === "error") return "Error";
  return state || "Waiting";
}

export function downloadQueueLabel(status: DownloadStatus | undefined): string {
  if (!status) return "Waiting";
  if (status.error) return status.error;
  const percent = progressPercent(status);
  if (status.progress === 1) return "Downloaded";
  if (status.state === "unavailable") return "No qB";
  if (status.state === "missing") return "No torrent";
  if (QUEUED_STATES.has(status.state) || STALLED_STATES.has(status.state) || CHECKING_STATES.has(status.state) || status.state === "metaDL") {
    return percent === null ? stateLabel(status.state) : `${stateLabel(status.state)} - ${percent}%`;
  }
  if (percent === null) return stateLabel(status.state);
  const speed = status.downloadSpeed ? ` - ${formatSpeed(status.downloadSpeed)}` : "";
  const eta = status.eta && status.eta !== 8640000 ? ` - ${formatEta(status.eta)}` : "";
  return `${percent}%${speed}${eta}`;
}

export function downloadDetailRows(status: DownloadStatus | undefined): Array<[string, string]> {
  if (!status) return [["Status", "Waiting"]];
  const percent = progressPercent(status);
  return [
    ["Status", status.error ? status.error : percent === null ? stateLabel(status.state) : `${stateLabel(status.state)} (${percent}%)`],
    ["Info hash", status.infoHash ?? "-"],
    ["Downloaded", `${formatBytes(status.downloaded)} / ${formatBytes(status.size)}`],
    ["Remaining", formatBytes(status.amountLeft)],
    ["Speed", formatSpeed(status.downloadSpeed)],
    ["ETA", formatEta(status.eta)],
    ["Peers", `${status.seeds ?? 0} seeds / ${status.peers ?? 0} peers`],
    ["Save path", status.savePath ?? "-"],
    ["Content path", status.contentPath ?? "-"],
    ["Updated", new Date(status.lastUpdatedAt).toLocaleString()]
  ];
}
```

- [ ] **Step 4: Render compact queue progress**

Modify `apps/web/src/components/QueueTable.tsx` imports:

```ts
import { downloadQueueLabel, progressPercent } from "../download-status.js";
```

Add a `Download` header between `Step` and `Blockers`.

Add a cell between `job.humanStep` and blockers:

```tsx
                  <td>
                    <div className={`download-compact ${job.downloadStatus?.error ? "error" : ""}`}>
                      <div className="download-bar" aria-hidden="true">
                        <span style={{ width: `${progressPercent(job.downloadStatus) ?? 0}%` }} />
                      </div>
                      <span>{downloadQueueLabel(job.downloadStatus)}</span>
                    </div>
                  </td>
```

- [ ] **Step 5: Render selected-job download details**

Modify `apps/web/src/components/ReviewPanel.tsx` imports:

```ts
import { downloadDetailRows } from "../download-status.js";
```

Add this section after `Duplicate/PTP Result`:

```tsx
      <section>
        <h3>Download</h3>
        <div className="key-value download-detail">
          {downloadDetailRows(job.downloadStatus).map(([label, value]) => (
            <React.Fragment key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </React.Fragment>
          ))}
        </div>
      </section>
```

Update the React import to include `React`:

```ts
import React from "react";
```

- [ ] **Step 6: Poll every 3 seconds and add CSS**

Modify `apps/web/src/App.tsx` interval:

```ts
    }, 3000);
```

Add these styles to `apps/web/src/styles.css`:

```css
.download-compact {
  display: grid;
  min-width: 150px;
  gap: 5px;
  color: var(--text-muted);
  font-size: 12px;
}

.download-compact.error {
  color: var(--red);
}

.download-bar {
  width: 100%;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--muted-strong);
}

.download-bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--green);
}

.download-detail {
  grid-template-columns: minmax(96px, auto) minmax(0, 1fr);
}
```

Increase the table min width so the new column does not squeeze text:

```css
table {
  width: 100%;
  min-width: 1060px;
  border-collapse: collapse;
}
```

- [ ] **Step 7: Run web tests and commit**

Run:

```bash
npm test -- apps/web/src/download-status.test.ts
npm --workspace @popcorn-queue/web run typecheck
```

Expected: PASS.

Commit:

```bash
git add apps/web/src/types.ts apps/web/src/download-status.ts apps/web/src/download-status.test.ts apps/web/src/App.tsx apps/web/src/components/QueueTable.tsx apps/web/src/components/ReviewPanel.tsx apps/web/src/styles.css
git commit -m "feat(web): show job download progress"
```

---

### Task 6: Playwright Coverage And Final Verification

**Files:**
- Modify: `apps/web/e2e/ui.spec.ts`

- [ ] **Step 1: Update mocked jobs with download status**

In `apps/web/e2e/ui.spec.ts`, add this object to `apiJobs[0]`:

```ts
    downloadStatus: {
      client: "qbittorrent",
      infoHash: "ATHENAHASH",
      state: "uploading",
      progress: 1,
      downloaded: 10_000,
      size: 10_000,
      amountLeft: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      eta: 0,
      seeds: 8,
      peers: 0,
      savePath: "/data/jobs/job-athena/download",
      contentPath: "/data/jobs/job-athena/download/ATHENA.mkv",
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      error: null
    },
```

Add this object to `apiJobs[1]`:

```ts
    downloadStatus: {
      client: "qbittorrent",
      infoHash: "HOMEHASH",
      state: "downloading",
      progress: 0.42,
      downloaded: 4_200,
      size: 10_000,
      amountLeft: 5_800,
      downloadSpeed: 8_388_608,
      uploadSpeed: 0,
      eta: 720,
      seeds: 12,
      peers: 3,
      savePath: "/data/jobs/job-home/download",
      contentPath: "/data/jobs/job-home/download/Home.mkv",
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      error: null
    },
```

- [ ] **Step 2: Update existing desktop assertions**

In the desktop review workspace test, add:

```ts
    await expect(page.getByRole("columnheader", { name: "Download" })).toBeVisible();
    await expect(page.getByText("Downloaded")).toBeVisible();
    await expect(page.getByText("42% - 8.0 MB/s - 12m")).toBeVisible();
```

In the review section order test, update the expected headings:

```ts
    expect(headings).toEqual([
      "Blockers",
      "Warnings",
      "Duplicate/PTP Result",
      "Download",
      "Screenshots",
      "MediaInfo / BDInfo",
      "Release Draft",
      "Torrent / qB Readiness",
      "Recent Job Log"
    ]);
```

- [ ] **Step 3: Add selected-job download detail test**

Add this Playwright test:

```ts
  test("shows selected job download details from API status", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only download detail assertion.");
    await page.goto("/");

    await page.getByRole("link", { name: "Home.Sweet.Home.2021.1080p.WEB.x265-TJUPT" }).click();

    await expect(page.getByTestId("review-panel").getByRole("heading", { name: "Download" })).toBeVisible();
    await expect(page.getByTestId("review-panel")).toContainText("HOMEHASH");
    await expect(page.getByTestId("review-panel")).toContainText("Downloading (42%)");
    await expect(page.getByTestId("review-panel")).toContainText("4.1 KB / 9.8 KB");
    await expect(page.getByTestId("review-panel")).toContainText("12 seeds / 3 peers");
  });
```

- [ ] **Step 4: Run Playwright focused tests**

Run:

```bash
npm run test:e2e -- --project chromium-desktop apps/web/e2e/ui.spec.ts
```

Expected: PASS for desktop tests.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
```

Expected: all commands PASS. The e2e suite may keep existing skipped mobile/desktop-specific tests as skips.

- [ ] **Step 6: Commit final UI/test updates**

Commit:

```bash
git add apps/web/e2e/ui.spec.ts
git commit -m "test(web): cover download progress UI"
```

---

## Completion Criteria

- qB status is parsed from mocked qB Web API responses without real network access.
- Worker reports status snapshots during `download-or-locate`.
- API persists latest `downloadStatus` on each job and returns it from job APIs.
- Job logs show readable download progress without one line per poll.
- Queue table shows compact progress for all jobs.
- Selected-job review panel shows detailed download status.
- Download completion still automatically continues to review.
- `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:e2e` pass.
