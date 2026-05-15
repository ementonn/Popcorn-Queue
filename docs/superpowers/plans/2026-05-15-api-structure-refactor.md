# API Structure Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the API server entrypoint and API server tests by domain while preserving public API behavior.

**Architecture:** `apps/api/src/server.ts` remains the composition root: create Fastify, wire runtime dependencies, register shared hooks, and call route registration. Domain route modules live under `apps/api/src/routes/`, shared route dependencies flow through `ApiRouteContext`, and route-specific business logic moves into focused service modules under `apps/api/src/services/`.

**Tech Stack:** TypeScript, Fastify, Vitest, Prisma persistence mock, npm workspaces.

---

## File Structure

Create:

- `apps/api/src/api-context.ts`: shared route context type and dependency getter contracts.
- `apps/api/src/routes/index.ts`: registers all route modules.
- `apps/api/src/routes/auth.ts`: auth session/login/logout routes.
- `apps/api/src/routes/settings.ts`: settings read/save routes.
- `apps/api/src/routes/health.ts`: health and feature summary routes.
- `apps/api/src/routes/diagnostics.ts`: diagnostics routes.
- `apps/api/src/routes/jobs.ts`: job CRUD/status/log/action routes.
- `apps/api/src/routes/intake.ts`: manual intake routes.
- `apps/api/src/routes/browser.ts`: browser extension routes.
- `apps/api/src/services/diagnostics.ts`: diagnostics helpers and worker tool command mapping.
- `apps/api/src/services/job-delete.ts`: delete modes and cleanup.
- `apps/api/src/services/job-upload.ts`: upload/retry/resume/reseed/skip actions.
- `apps/api/src/services/ptp-cache-sync.ts`: uploaded torrent cache syncer.
- `apps/api/src/services/restore.ts`: restored job file validation.
- `apps/api/src/server-test-utils.ts`: shared API server test helpers and persistence mock.
- `apps/api/src/server.cache.test.ts`: cache, health, auth, settings, diagnostics tests.
- `apps/api/src/server.jobs.test.ts`: non-delete job lifecycle tests.
- `apps/api/src/server.jobs-delete.test.ts`: delete mode tests.
- `apps/api/src/server.intake.test.ts`: manual intake tests.
- `apps/api/src/server.browser.test.ts`: browser extension route tests.

Modify:

- `apps/api/src/server.ts`: remove route handlers and route-specific helpers after extraction.
- `apps/api/src/server.test.ts`: shrink and then delete after tests move.

Do not modify:

- Worker phase behavior.
- Web UI behavior.
- Persistence schema.
- API response schemas.

---

### Task 1: Capture Baseline And Introduce API Route Context

**Files:**

- Create: `apps/api/src/api-context.ts`
- Create: `apps/api/src/routes/index.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/server.test.ts`

- [ ] **Step 1: Run the baseline API server tests**

Run:

```bash
npm test -- apps/api/src/server.test.ts
```

Expected: all tests pass before any refactor changes. If this fails, stop and inspect the failure before editing.

- [ ] **Step 2: Create the API route context type**

Create `apps/api/src/api-context.ts` with this content:

```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import type { BrowserCheckResult, CacheStore, NormalizedPtpResponse } from "@popcorn-queue/core";
import type { BrowserCheckService, PtpClient } from "@popcorn-queue/integrations";
import type { CommandExecutor, PtpSubmitter, TorrentDownloadClient } from "@popcorn-queue/worker";
import type { WebSessionAuth, makeBrowserAuthHook } from "./auth.js";
import type { ApiConfig } from "./config.js";
import type { JobRepository } from "./jobs.js";
import type { PreparationService } from "./preparation.js";

export interface BuildServerOptions {
  autoPrepare?: boolean;
  ptpSubmitter?: PtpSubmitter;
  torrentClient?: TorrentDownloadClient;
  commandExecutor?: CommandExecutor;
  fetchImpl?: typeof fetch;
  settingsEnvPath?: string;
}

export interface ApiRouteContext {
  config(): ApiConfig;
  jobRepository: JobRepository;
  cache: CacheStore<NormalizedPtpResponse>;
  options: BuildServerOptions;
  settingsEnvPath: string;
  getPtpClient(): PtpClient;
  getBrowserChecks(): BrowserCheckService;
  getTorrentClient(): TorrentDownloadClient | null;
  getPtpSubmitter(): PtpSubmitter | undefined;
  getPreparation(): PreparationService;
  getWebAuth(): WebSessionAuth;
  getBrowserAuthHook(): ReturnType<typeof makeBrowserAuthHook>;
  enqueuePreparation(jobId: string): void;
  applyRuntimeConfig(config: ApiConfig): void;
}

export type BrowserAuthHook = (
  request: FastifyRequest<{ Body: BrowserCheckResult }>,
  reply: FastifyReply
) => Promise<void>;
```

If `BrowserAuthHook` is not needed after implementation, remove it in the same task before committing.

- [ ] **Step 3: Create an empty route registration entrypoint**

Create `apps/api/src/routes/index.ts` with this content:

```ts
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";

export function registerApiRoutes(_app: FastifyInstance, _context: ApiRouteContext): void {
  // Route modules are registered in later tasks.
}
```

- [ ] **Step 4: Move `BuildServerOptions` usage to the context type**

Modify `apps/api/src/server.ts`:

```ts
import type { BuildServerOptions, ApiRouteContext } from "./api-context.js";
import { registerApiRoutes } from "./routes/index.js";
```

Remove the local `export interface BuildServerOptions` from `server.ts`.

Inside `buildServer`, after `enqueuePreparation` and `resumeInterruptedPreparation` are defined, create the context:

```ts
  const routeContext: ApiRouteContext = {
    config: () => config,
    jobRepository,
    cache,
    options,
    settingsEnvPath,
    getPtpClient: () => ptpClient,
    getBrowserChecks: () => browserChecks,
    getTorrentClient: () => torrentClient,
    getPtpSubmitter: () => ptpSubmitter,
    getPreparation: () => preparation,
    getWebAuth: () => webAuth,
    getBrowserAuthHook: () => browserAuthHook,
    enqueuePreparation,
    applyRuntimeConfig
  };
```

Before `return app;`, call:

```ts
  registerApiRoutes(app, routeContext);
```

At this point `registerApiRoutes` is empty, so all existing inline routes still serve requests.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm test -- apps/api/src/server.test.ts
npm run typecheck
```

Expected: API server tests pass and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/api-context.ts apps/api/src/routes/index.ts apps/api/src/server.ts
git commit -m "Introduce API route context"
```

---

### Task 2: Extract Low-Risk Routes And Diagnostics Helpers

**Files:**

- Create: `apps/api/src/routes/auth.ts`
- Create: `apps/api/src/routes/settings.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/routes/diagnostics.ts`
- Create: `apps/api/src/services/diagnostics.ts`
- Modify: `apps/api/src/routes/index.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/server.test.ts`

- [ ] **Step 1: Create diagnostics service helpers**

Create `apps/api/src/services/diagnostics.ts`. Move these helpers from `server.ts` into it and export them:

```ts
export type DiagnosticCheckStatus = "not_checked" | "ok" | "configured" | "missing" | "failed" | "disabled";
export type DiagnosticCheckTarget = "qbittorrent" | "ptp" | "image-host" | "tools";

export function sqliteDatabasePath(): string | null;
export async function fileSize(filePath: string | null): Promise<number | null>;
export async function freeBytes(filePath: string): Promise<number | null>;
export async function cacheEntryCount(cache: unknown): Promise<number | null>;
export function integrationSummary(config: ApiConfig, target: DiagnosticCheckTarget): {
  configured: boolean;
  status: DiagnosticCheckStatus;
  detail: string;
};
export function toolCommandMap(config: ApiConfig): Partial<Record<WorkerTool, string>>;
export function toolCheckStatus(tools: Awaited<ReturnType<typeof checkWorkerTools>>): DiagnosticCheckStatus;
export async function collectToolDiagnostics(config: ApiConfig, commandExecutor?: CommandExecutor);
export function queueDiagnostics(jobs: Job[]);
```

Use the existing bodies from `server.ts` without behavior changes. Import `access`, `stat`, `statfs`, `checkWorkerTools`, `ApiConfig`, `Job`, `CommandExecutor`, and `WorkerTool` as needed. Remove the moved helper definitions from `server.ts`.

- [ ] **Step 2: Extract auth routes**

Create `apps/api/src/routes/auth.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";

export function registerAuthRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  app.get("/api/auth/session", async (request) => context.getWebAuth().info(request));

  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
    const body = request.body ?? {};
    return context.getWebAuth().login(String(body.username ?? ""), String(body.password ?? ""), reply);
  });

  app.post("/api/auth/logout", async (request, reply) => context.getWebAuth().logout(request, reply));
}
```

Remove the three auth route registrations from `server.ts`.

- [ ] **Step 3: Extract settings routes**

Create `apps/api/src/routes/settings.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { loadConfigFromEnvPath, saveSettingsEnv, settingsResponse, type SaveSettingsInput } from "../settings.js";
import type { ApiRouteContext } from "../api-context.js";

export function registerSettingsRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  app.get("/api/settings", async () => settingsResponse(context.settingsEnvPath, context.config()));

  app.patch<{ Body: SaveSettingsInput }>("/api/settings", async (request, reply) => {
    try {
      await saveSettingsEnv(context.settingsEnvPath, request.body ?? {});
      context.applyRuntimeConfig(loadConfigFromEnvPath(context.settingsEnvPath));
      return reply.send({
        ...settingsResponse(context.settingsEnvPath, context.config()),
        saved: true,
        reloaded: true,
        restartRequired: false
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "settings_save_failed" });
    }
  });
}
```

Remove settings route registrations and unused settings imports from `server.ts`.

- [ ] **Step 4: Extract health and features routes**

Create `apps/api/src/routes/health.ts`. Copy the current `/api/health` and `/api/features` handler bodies from `server.ts`, replacing `config` with `context.config()`.

Use this signature:

```ts
import type { FastifyInstance } from "fastify";
import type { ApiConfig } from "../config.js";
import type { ApiRouteContext } from "../api-context.js";

function configuredImageHosts(config: ApiConfig): string[] {
  const primary = config.integrations.imageHost;
  const hosts = [
    primary && (primary !== "imgbb" || config.integrations.imgbbApiKey) ? primary : "",
    primary !== "imgbb" && config.integrations.imgbbApiKey ? "imgbb" : "",
    primary !== "ptpimg" && config.integrations.ptpImgApiKey ? "ptpimg" : "",
    "imgbox",
    "freeimage"
  ].filter(Boolean);
  return [...new Set(hosts)];
}

export function registerHealthRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  app.get("/api/health", async () => {
    const config = context.config();
    return {
      ok: true,
      ptpConfigured: Boolean(config.ptp.apiUser && config.ptp.apiKey),
      browserTokenConfigured: Boolean(config.browserToken),
      cachePolicy: "permanent",
      persistence: "sqlite",
      publicWebUrl: config.publicWebUrl,
      publicApiUrl: config.publicApiUrl,
      external: {
        tmdbConfigured: Boolean(config.integrations.tmdbApiKey),
        imageHost: config.integrations.imageHost,
        imgbbConfigured: Boolean(config.integrations.imgbbApiKey),
        ptpImgConfigured: Boolean(config.integrations.ptpImgApiKey),
        torrentClientConfigured: Boolean(config.integrations.qbittorrentUrl),
        externalToolsEnabled: config.integrations.runExternalTools,
        tools: {
          ffmpeg: config.integrations.ffmpegBin,
          mediainfo: config.integrations.mediainfoBin,
          mkvmerge: config.integrations.mkvmergeBin,
          mpv: config.integrations.mpvBin,
          oxipng: config.integrations.oxipngBin,
          "xvfb-run": config.integrations.xvfbRunBin
        }
      }
    };
  });

  app.get("/api/features", async () => {
    const config = context.config();
    return {
      features: [
        {
          id: "ptp-cache",
          name: "Backend PTP cache",
          status: "implemented",
          detail: "PTP lookups are cached permanently in the API until manually refreshed or invalidated."
        },
        {
          id: "upload-plan",
          name: "Upsies-style upload plan",
          status: "implemented",
          detail: "Every job receives metadata, release-name, scene, screenshot, torrent-reuse, media, and review-gate plans."
        },
        {
          id: "phase-runner",
          name: "Restartable upload phases",
          status: "implemented",
          detail: "Jobs can be started, paused, retried, skipped through debug routing, and blocked by review gates."
        },
        {
          id: "ptp-rules",
          name: "PTP rule gates",
          status: "implemented",
          detail: "Banned groups, EVO encode handling, MP4 remux checks, missing IMDb, and parse-confidence warnings are surfaced as review gates."
        },
        {
          id: "external-enrichment",
          name: "IMDb/TMDb/TVmaze enrichment",
          status: "planned",
          detail: config.integrations.tmdbApiKey
            ? "TMDb is configured for manual integration testing; provider clients still run through the metadata phase contract."
            : "Provider plans are generated now; add TMDB_API_KEY when live provider clients are wired into the metadata phase."
        },
        {
          id: "image-host-upload",
          name: "Screenshot host fallback",
          status: "planned",
          detail: config.integrations.imgbbApiKey || config.integrations.ptpImgApiKey
            ? `${configuredImageHosts(config).join(", ")} configured for screenshot hosting plans.`
            : "Screenshot timestamps and fallback hosts are planned now; add IMGBB_API_KEY or PTPIMG_API_KEY when image-host upload is enabled."
        },
        {
          id: "torrent-client",
          name: "Torrent client handoff",
          status: "planned",
          detail: config.integrations.qbittorrentUrl
            ? "qBittorrent connection details are configured for manual service wiring."
            : "Set QBITTORRENT_URL and credentials when seed-start handoff is enabled."
        },
        {
          id: "external-tools",
          name: "Worker media tools",
          status: config.integrations.runExternalTools ? "configured" : "disabled",
          detail: config.integrations.runExternalTools
            ? `Worker may run ${config.integrations.ffmpegBin}, ${config.integrations.mediainfoBin}, ${config.integrations.mkvmergeBin}, and ${config.integrations.oxipngBin} during manual execution.`
            : "External tools are disabled; media preparation will skip or mock command execution."
        }
      ]
    };
  });
}
```

Remove health and features route registrations from `server.ts`.

- [ ] **Step 5: Extract diagnostics routes**

Create `apps/api/src/routes/diagnostics.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";
import { readLogTail } from "../job-logs.js";
import {
  cacheEntryCount,
  collectToolDiagnostics,
  fileSize,
  freeBytes,
  integrationSummary,
  queueDiagnostics,
  sqliteDatabasePath,
  toolCheckStatus,
  type DiagnosticCheckTarget
} from "../services/diagnostics.js";

const DIAGNOSTIC_TARGETS = new Set<DiagnosticCheckTarget>(["qbittorrent", "ptp", "image-host", "tools"]);

export function registerDiagnosticsRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  app.get("/api/logs/global", async () => ({
    api: await readLogTail(context.config().paths.apiLogFile, 200)
  }));

  app.get("/api/diagnostics", async () => {
    const config = context.config();
    const jobs = await context.jobRepository.list();
    const databasePath = sqliteDatabasePath();
    const tools = await collectToolDiagnostics(config, context.options.commandExecutor);
    return {
      system: {
        api: "online",
        persistence: "sqlite",
        publicWebUrl: config.publicWebUrl,
        publicApiUrl: config.publicApiUrl,
        browserBridgeConfigured: Boolean(config.browserToken),
        ptpApiConfigured: Boolean(config.ptp.apiUser && config.ptp.apiKey),
        externalToolsEnabled: config.integrations.runExternalTools
      },
      integrations: {
        qbittorrent: integrationSummary(config, "qbittorrent"),
        ptp: integrationSummary(config, "ptp"),
        imageHost: integrationSummary(config, "image-host"),
        tools: integrationSummary(config, "tools")
      },
      queue: queueDiagnostics(jobs),
      tools,
      storage: {
        dataRoot: config.paths.dataRoot,
        databasePath,
        jobCount: jobs.length,
        cacheEntries: await cacheEntryCount(context.cache),
        databaseBytes: await fileSize(databasePath),
        dataRootFreeBytes: await freeBytes(config.paths.dataRoot)
      },
      logs: {
        api: await readLogTail(config.paths.apiLogFile, 200)
      }
    };
  });

  app.post<{ Params: { target: DiagnosticCheckTarget } }>("/api/diagnostics/check/:target", async (request, reply) => {
    const target = request.params.target;
    const config = context.config();
    if (!DIAGNOSTIC_TARGETS.has(target)) return reply.code(404).send({ error: "diagnostic_target_not_found" });
    const checkedAt = new Date().toISOString();
    const summary = integrationSummary(config, target);
    if (target === "tools" && !config.integrations.runExternalTools) {
      return { target, configured: false, status: "disabled" as const, detail: "External tools are disabled.", checkedAt };
    }
    if (!summary.configured) return { target, ...summary, status: "missing" as const, checkedAt };
    if (target === "qbittorrent") {
      try {
        const torrentClient = context.getTorrentClient();
        if (torrentClient?.ping) await torrentClient.ping();
        return { target, configured: true, status: torrentClient?.ping ? "ok" : "configured", detail: torrentClient?.ping ? "qBittorrent responded." : "qBittorrent is configured.", checkedAt };
      } catch (error) {
        return { target, configured: true, status: "failed" as const, detail: error instanceof Error ? error.message : "qBittorrent check failed.", checkedAt };
      }
    }
    if (target === "tools") {
      const tools = await collectToolDiagnostics(config, context.options.commandExecutor);
      const status = toolCheckStatus(tools);
      return {
        target,
        configured: true,
        status,
        detail: status === "ok" ? "External media tools are available." : "One or more external media tools are unavailable.",
        tools,
        checkedAt
      };
    }
    return { target, configured: true, status: "configured" as const, detail: summary.detail, checkedAt };
  });
}
```

Remove diagnostics route registrations and moved imports from `server.ts`.

- [ ] **Step 6: Register low-risk route modules**

Modify `apps/api/src/routes/index.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";
import { registerAuthRoutes } from "./auth.js";
import { registerDiagnosticsRoutes } from "./diagnostics.js";
import { registerHealthRoutes } from "./health.js";
import { registerSettingsRoutes } from "./settings.js";

export function registerApiRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  registerAuthRoutes(app, context);
  registerSettingsRoutes(app, context);
  registerHealthRoutes(app, context);
  registerDiagnosticsRoutes(app, context);
}
```

- [ ] **Step 7: Keep runtime setup importing `toolCommandMap`**

Modify `server.ts` to import `toolCommandMap` from `./services/diagnostics.js` because `applyRuntimeConfig` still needs it for `PreparationService`.

```ts
import { toolCommandMap } from "./services/diagnostics.js";
```

Remove local `DiagnosticCheckStatus`, `DiagnosticCheckTarget`, diagnostics helpers, and unused `stat`, `statfs` imports from `server.ts`.

- [ ] **Step 8: Run tests and typecheck**

Run:

```bash
npm test -- apps/api/src/server.test.ts
npm run typecheck
```

Expected: all API server tests pass and typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/api-context.ts apps/api/src/routes apps/api/src/services/diagnostics.ts
git commit -m "Extract low-risk API routes"
```

---

### Task 3: Extract PTP Cache Sync And Job Action Services

**Files:**

- Create: `apps/api/src/services/ptp-cache-sync.ts`
- Create: `apps/api/src/services/job-upload.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/server.test.ts`

- [ ] **Step 1: Extract PTP cache sync service**

Create `apps/api/src/services/ptp-cache-sync.ts`. Move these helpers from `server.ts` into it:

```ts
function optionalString(value: string | null | undefined): string | undefined;
function uploadedPtpTorrent(input: PtpCacheSyncInput): PtpTorrent;
function fallbackPtpMovie(input: PtpCacheSyncInput): PtpMovie;
function withUploadedTorrent(movie: PtpMovie, torrent: PtpTorrent): PtpMovie;
function syncUploadedTorrentData(data: NormalizedPtpResponse, input: PtpCacheSyncInput): {
  data: NormalizedPtpResponse;
  torrentCount: number;
};
export function createPtpCacheSyncer(cache: CacheStore<NormalizedPtpResponse>): PtpCacheSyncer;
```

Use the current bodies from `server.ts` without behavior changes. Import `makePtpCacheKey`, `CacheStore`, `NormalizedPtpResponse`, `PtpMovie`, `PtpTorrent` from `@popcorn-queue/core` and `PtpCacheSyncInput`, `PtpCacheSyncer` from `@popcorn-queue/worker`.

Remove the moved helper definitions from `server.ts`.

- [ ] **Step 2: Create job upload service**

Create `apps/api/src/services/job-upload.ts` with exported action functions:

```ts
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildJobWorkspacePaths, type CacheStore, type NormalizedPtpResponse, type UploadPhase } from "@popcorn-queue/core";
import { PhaseRunner, createPhaseContext, type CreatePhaseContextOptions, type PhaseLogLevel, type PhaseOutputMap, type PtpSubmitter, type TorrentDownloadClient } from "@popcorn-queue/worker";
import type { ApiConfig } from "../config.js";
import { appendJobEvent } from "../job-logs.js";
import type { Job, JobRepository, PhaseRun, PhaseState } from "../jobs.js";
import { RETRYABLE_COMPLETED_PHASES } from "../jobs.js";
import type { PreparationService } from "../preparation.js";
import { createPtpCacheSyncer } from "./ptp-cache-sync.js";

export interface JobActionContext {
  config(): ApiConfig;
  jobs: JobRepository;
  cache: CacheStore<NormalizedPtpResponse>;
  getTorrentClient(): TorrentDownloadClient | null;
  getPtpSubmitter(): PtpSubmitter | undefined;
  getPreparation(): PreparationService;
  enqueuePreparation(jobId: string): void;
}
```

Move these helper functions from `server.ts` into this service:

```ts
function phaseStateFromStatus(status: PhaseOutputMap[UploadPhase]["status"]): PhaseState;
function mergePhaseRuns(job: Job, outputs: Partial<PhaseOutputMap>): PhaseRun[];
function jobLogPath(config: ApiConfig, job: Job): string;
```

Move and adapt these functions so they receive `JobActionContext` as their first argument:

```ts
export async function startUploadJob(context: JobActionContext, id: string): Promise<Job | null>;
export async function retryFailedJob(context: JobActionContext, id: string): Promise<Job | null>;
export async function retryCompletedPhaseJob(context: JobActionContext, id: string, phase: UploadPhase): Promise<Job | null>;
export async function reseedJob(context: JobActionContext, id: string): Promise<Job | null>;
export async function resumeJob(context: JobActionContext, id: string): Promise<Job | null>;
export async function skipJob(context: JobActionContext, id: string): Promise<Job | null>;
```

Inside the moved bodies:

- replace `config` with `context.config()`;
- replace `jobRepository` with `context.jobs`;
- replace `cache` with `context.cache`;
- replace `torrentClient` with `context.getTorrentClient()`;
- replace `ptpSubmitter` with `context.getPtpSubmitter()`;
- replace `preparation` with `context.getPreparation()`;
- replace `enqueuePreparation(id)` with `context.enqueuePreparation(id)`.

Keep all response behavior and repository method calls the same.

- [ ] **Step 3: Import job action services in `server.ts`**

Modify `server.ts`:

```ts
import {
  reseedJob,
  resumeJob,
  retryCompletedPhaseJob,
  retryFailedJob,
  skipJob,
  startUploadJob,
  type JobActionContext
} from "./services/job-upload.js";
```

Create an action context inside `buildServer` after `routeContext`:

```ts
  const jobActionContext: JobActionContext = {
    config: () => config,
    jobs: jobRepository,
    cache,
    getTorrentClient: () => torrentClient,
    getPtpSubmitter: () => ptpSubmitter,
    getPreparation: () => preparation,
    enqueuePreparation
  };
```

Update remaining inline route handlers:

```ts
const job = await startUploadJob(jobActionContext, request.params.id);
const job = await resumeJob(jobActionContext, request.params.id);
const job = await retryFailedJob(jobActionContext, request.params.id);
const job = await retryCompletedPhaseJob(jobActionContext, request.params.id, phase);
const job = await reseedJob(jobActionContext, request.params.id);
const job = await skipJob(jobActionContext, request.params.id);
```

Remove the local moved functions from `server.ts`.

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npm test -- apps/api/src/server.test.ts
npm run typecheck
```

Expected: all API server tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/services/ptp-cache-sync.ts apps/api/src/services/job-upload.ts
git commit -m "Extract API job action services"
```

---

### Task 4: Extract Job Delete, Restore, And Job Routes

**Files:**

- Create: `apps/api/src/services/job-delete.ts`
- Create: `apps/api/src/services/restore.ts`
- Create: `apps/api/src/routes/jobs.ts`
- Modify: `apps/api/src/routes/index.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/server.test.ts`

- [ ] **Step 1: Extract restore helper**

Create `apps/api/src/services/restore.ts`:

```ts
import { access } from "node:fs/promises";
import path from "node:path";
import type { JobManifest } from "@popcorn-queue/core";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function missingRestoredFiles(jobPath: string, manifest: JobManifest): Promise<string[]> {
  const relativePaths = [...manifest.uploadFiles];
  if (manifest.torrentFile) relativePaths.push(manifest.torrentFile);
  const missing: string[] = [];
  for (const relativePath of relativePaths) {
    if (!(await pathExists(path.join(jobPath, relativePath)))) missing.push(relativePath);
  }
  return missing;
}
```

Remove local `missingRestoredFiles` from `server.ts`.

- [ ] **Step 2: Extract delete service**

Create `apps/api/src/services/job-delete.ts`. Move delete-related types and helpers from `server.ts` into it:

```ts
export type DeleteJobMode = "queue" | "downloads" | "everything";

export interface DeleteJobBody {
  mode?: DeleteJobMode;
  confirm?: boolean;
}

export interface TorrentCleanupResult {
  infoHash: string;
  role: "download" | "seed";
  status: "removed" | "skipped" | "failed";
  deleteData: boolean;
  message: string;
}

export interface JobDeleteCleanupResult {
  localPaths: Array<{ path: string; status: "deleted" | "skipped" | "failed"; message: string }>;
  torrents: TorrentCleanupResult[];
}
```

Move these helper functions without behavior changes:

```ts
function jobRootPath(config: ApiConfig, job: Job): string;
function isInsideOrEqual(parentPath: string, childPath: string | null | undefined): boolean;
async function removeLocalPath(targetPath: string): Promise<JobDeleteCleanupResult["localPaths"][number]>;
async function removeJobTorrent(
  client: TorrentDownloadClient | null,
  infoHash: string | null | undefined,
  role: "download" | "seed",
  deleteDataRoot: string
): Promise<TorrentCleanupResult | null>;
function jobDownloadInfoHash(job: Job): string | null;
async function deleteJobDownloads(config: ApiConfig, job: Job, client: TorrentDownloadClient | null): Promise<JobDeleteCleanupResult>;
async function deleteEntireJob(config: ApiConfig, job: Job, client: TorrentDownloadClient | null): Promise<JobDeleteCleanupResult>;
```

Add the exported route-facing function:

```ts
export async function deleteJob(input: {
  config: ApiConfig;
  jobs: JobRepository;
  torrentClient: TorrentDownloadClient | null;
  id: string;
  body: DeleteJobBody | undefined;
}): Promise<
  | { status: 200; body: { job: Job; cleanup: JobDeleteCleanupResult } }
  | { status: 200; body: { deleted: true; jobId: string; cleanup: JobDeleteCleanupResult } }
  | { status: 400; body: { error: "unknown_delete_mode" | "delete_confirmation_required" } }
  | { status: 404; body: { error: "job_not_found" } }
> {
  const mode = input.body?.mode;
  if (!mode || !["queue", "downloads", "everything"].includes(mode)) {
    return { status: 400, body: { error: "unknown_delete_mode" } };
  }
  if (input.body?.confirm !== true) {
    return { status: 400, body: { error: "delete_confirmation_required" } };
  }

  const job = await input.jobs.get(input.id);
  if (!job) return { status: 404, body: { error: "job_not_found" } };

  if (mode === "queue") {
    const removed = await input.jobs.removeFromQueue(input.id);
    return removed
      ? { status: 200, body: { job: removed, cleanup: { localPaths: [], torrents: [] } } }
      : { status: 404, body: { error: "job_not_found" } };
  }

  if (mode === "downloads") {
    const cleanup = await deleteJobDownloads(input.config, job, input.torrentClient);
    const updated = await input.jobs.markDownloadFilesDeleted(input.id);
    return updated
      ? { status: 200, body: { job: updated, cleanup } }
      : { status: 404, body: { error: "job_not_found" } };
  }

  const cleanup = await deleteEntireJob(input.config, job, input.torrentClient);
  const deleted = await input.jobs.delete(input.id);
  return deleted
    ? { status: 200, body: { deleted: true, jobId: input.id, cleanup } }
    : { status: 404, body: { error: "job_not_found" } };
}
```

Remove the moved delete definitions from `server.ts`.

- [ ] **Step 3: Extract job routes**

Create `apps/api/src/routes/jobs.ts`. Move all `/api/jobs` route registrations from `server.ts` into this file:

```ts
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildJobWorkspacePaths, type JobManifest, type ReviewDraftPatch, type TorrentCandidate, type UploadPhase } from "@popcorn-queue/core";
import type { ApiRouteContext } from "../api-context.js";
import { readLogTail } from "../job-logs.js";
import { JOB_PHASES, RETRYABLE_COMPLETED_PHASES } from "../jobs.js";
import { deleteJob, type DeleteJobBody } from "../services/job-delete.js";
import { missingRestoredFiles } from "../services/restore.js";
import { reseedJob, resumeJob, retryCompletedPhaseJob, retryFailedJob, skipJob, startUploadJob, type JobActionContext } from "../services/job-upload.js";
```

At the top of the file, define:

```ts
interface CreateManualJobBody extends Partial<TorrentCandidate> {
  title: string;
}

interface ImportJobBody {
  jobPath: string;
  manifest?: JobManifest;
}
```

Inside `registerJobRoutes(app, context)`, create:

```ts
  const actionContext: JobActionContext = {
    config: context.config,
    jobs: context.jobRepository,
    cache: context.cache,
    getTorrentClient: context.getTorrentClient,
    getPtpSubmitter: context.getPtpSubmitter,
    getPreparation: context.getPreparation,
    enqueuePreparation: context.enqueuePreparation
  };
```

Move these routes into `registerJobRoutes`:

- `GET /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/download-status`
- `GET /api/jobs/:id/logs`
- `POST /api/jobs`
- `POST /api/jobs/import`
- `POST /api/jobs/:id/start-upload`
- `POST /api/jobs/:id/start`
- `PATCH /api/jobs/:id/review-draft`
- `POST /api/jobs/:id/pause`
- `POST /api/jobs/:id/resume`
- `POST /api/jobs/:id/retry-failed`
- `POST /api/jobs/:id/phases/:phase/retry`
- `POST /api/jobs/:id/retry`
- `POST /api/jobs/:id/reseed`
- `POST /api/jobs/:id/debug/skip`
- `POST /api/jobs/:id/delete`
- `POST /api/jobs/:id/plan/refresh`
- `POST /api/jobs/:id/review-gates/:gateId/resolve`

Use `context.config()` where the old code used `config`, `context.jobRepository` where it used `jobRepository`, and `context.enqueuePreparation` where it used `enqueuePreparation`.

For import restore, use:

```ts
const torrentClient = context.getTorrentClient();
```

For delete, use:

```ts
const result = await deleteJob({
  config: context.config(),
  jobs: context.jobRepository,
  torrentClient: context.getTorrentClient(),
  id: request.params.id,
  body: request.body
});
return reply.code(result.status).send(result.body);
```

- [ ] **Step 4: Register job routes**

Modify `apps/api/src/routes/index.ts`:

```ts
import { registerJobRoutes } from "./jobs.js";
```

Add `registerJobRoutes(app, context);` after diagnostics routes.

Remove all moved job route registrations and unused job route imports from `server.ts`.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm test -- apps/api/src/server.test.ts
npm run typecheck
```

Expected: all API server tests pass and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/routes apps/api/src/services/job-delete.ts apps/api/src/services/job-upload.ts apps/api/src/services/restore.ts
git commit -m "Extract API job routes"
```

---

### Task 5: Extract Intake And Browser Routes

**Files:**

- Create: `apps/api/src/routes/intake.ts`
- Create: `apps/api/src/routes/browser.ts`
- Modify: `apps/api/src/routes/index.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/server.test.ts`

- [ ] **Step 1: Extract intake routes**

Create `apps/api/src/routes/intake.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";
import { createManualIntakeJob, IntakeError, readManualIntakeRequest, resolveManualPtpTarget, searchPtpMovies, validateMediaPath } from "../intake.js";

export function registerIntakeRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  app.post<{ Body: { mediaPath?: string } }>("/api/intake/media-path/validate", async (request) => {
    return validateMediaPath(request.body?.mediaPath ?? "");
  });

  app.post<{ Body: { title?: string; mediaPath?: string } }>("/api/intake/ptp-search", async (request) => {
    return searchPtpMovies(request.body ?? {}, context.getPtpClient());
  });

  app.post<{ Body: { ptpUrl?: string; imdbUrl?: string } }>("/api/intake/ptp-target/resolve", async (request, reply) => {
    try {
      const target = await resolveManualPtpTarget(request.body ?? {}, context.getPtpClient());
      return { target };
    } catch (error) {
      if (error instanceof IntakeError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  app.post("/api/intake/jobs", async (request, reply) => {
    try {
      const input = await readManualIntakeRequest(request, context.options.fetchImpl ?? fetch);
      if (input.mediaPath) {
        const media = await validateMediaPath(input.mediaPath);
        if (!media.ok) return reply.code(400).send({ error: media.error ?? "invalid_media_path", media });
      }
      const job = await createManualIntakeJob({
        dataRoot: context.config().paths.dataRoot,
        jobRepository: context.jobRepository,
        releaseName: input.releaseName,
        ptpTarget: input.ptpTarget,
        ptpClient: context.getPtpClient(),
        ...(input.mediaPath ? { mediaPath: input.mediaPath } : {}),
        ...(input.torrent ? { torrent: input.torrent } : {})
      });
      context.enqueuePreparation(job.id);
      return reply.code(201).send({ job });
    } catch (error) {
      if (error instanceof IntakeError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
```

Remove the moved intake routes and unused intake imports from `server.ts`.

- [ ] **Step 2: Extract browser routes**

Create `apps/api/src/routes/browser.ts`. Move browser routes from `server.ts` into it:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { buildJobWorkspacePaths, type BrowserCheckResult, type TorrentCandidate } from "@popcorn-queue/core";
import type { FastifyInstance } from "fastify";
import type { ApiRouteContext } from "../api-context.js";
import { normalizeUploadedFilename } from "../filenames.js";

export function registerBrowserRoutes(app: FastifyInstance, context: ApiRouteContext): void {
  const browserAuth = async (...args: Parameters<ReturnType<ApiRouteContext["getBrowserAuthHook"]>>) => context.getBrowserAuthHook()(...args);

  app.post<{ Body: { candidates: TorrentCandidate[]; bypassCache?: boolean } }>(
    "/api/browser/check/batch",
    { preHandler: browserAuth },
    async (request) => {
      const candidates = request.body?.candidates ?? [];
      const options: { bypassCache?: boolean } = {};
      if (request.body?.bypassCache !== undefined) options.bypassCache = request.body.bypassCache;
      request.log.info({ candidateCount: candidates.length, bypassCache: Boolean(options.bypassCache) }, "browser check batch started");
      const results = await context.getBrowserChecks().checkBatch(candidates, options);
      const cacheHits = results.filter((result) => result.cache.hit).length;
      request.log.info({ candidateCount: candidates.length, resultCount: results.length, cacheHits }, "browser check batch completed");
      return { results };
    }
  );

  app.post<{ Body: TorrentCandidate & { bypassCache?: boolean } }>(
    "/api/browser/check",
    { preHandler: browserAuth },
    async (request) => {
      const body = request.body;
      const options: { bypassCache?: boolean } = {};
      if (body.bypassCache !== undefined) options.bypassCache = body.bypassCache;
      const result = await context.getBrowserChecks().check(body, options);
      return { result };
    }
  );

  app.post<{ Body: Pick<TorrentCandidate, "title" | "imdbId"> }>(
    "/api/browser/cache/invalidate",
    { preHandler: browserAuth },
    async (request) => {
      const key = await context.getBrowserChecks().invalidate(request.body);
      return { ok: true, key };
    }
  );
```

Continue the same file by moving the full existing `POST /api/browser/jobs` handler body. Replace:

- `config.paths.dataRoot` with `context.config().paths.dataRoot`;
- `jobRepository` with `context.jobRepository`;
- `enqueuePreparation(job.id)` with `context.enqueuePreparation(job.id)`.

Close the function after the browser job route.

Remove the moved browser routes and unused imports from `server.ts`.

- [ ] **Step 3: Register intake and browser routes**

Modify `apps/api/src/routes/index.ts`:

```ts
import { registerBrowserRoutes } from "./browser.js";
import { registerIntakeRoutes } from "./intake.js";
```

Add:

```ts
  registerIntakeRoutes(app, context);
  registerBrowserRoutes(app, context);
```

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npm test -- apps/api/src/server.test.ts
npm run typecheck
```

Expected: all API server tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/routes
git commit -m "Extract intake and browser API routes"
```

---

### Task 6: Reduce `server.ts` To Composition Root

**Files:**

- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/services/diagnostics.ts`
- Test: `apps/api/src/server.test.ts`

- [ ] **Step 1: Keep only runtime helpers in `server.ts`**

After prior tasks, `server.ts` should keep:

- imports for Fastify, cors, multipart, runtime clients, auth, config, logger, persistence, preparation, settings env path, route registration, diagnostics `toolCommandMap`, and context types;
- `configuredPtpSubmitter`;
- `configuredImageHosts`;
- CORS helper functions: `urlPort`, `hostnameFromHostHeader`, `configuredWebPorts`, `isSameHostWebOrigin`, `isCorsOriginAllowed`;
- `buildServer`.

Remove leftover route-specific helpers if they remain:

- PTP cache sync helpers;
- delete helpers;
- diagnostics helpers;
- restore helpers;
- upload action helpers;
- browser multipart route code;
- intake route code.

- [ ] **Step 2: Ensure `registerApiRoutes` is the only route registration call block**

Inside `buildServer`, after hooks and plugin registration, keep:

```ts
  app.addHook("preHandler", async (request, reply) => webAuth.hook()(request, reply));

  registerApiRoutes(app, routeContext);

  return app;
```

There should be no direct `app.get(...)`, `app.post(...)`, or `app.patch(...)` calls left in `server.ts` except hook/plugin setup.

- [ ] **Step 3: Run focused route search**

Run:

```bash
rg -n "app\\.(get|post|patch|delete|put)" apps/api/src/server.ts apps/api/src/routes
wc -l apps/api/src/server.ts
```

Expected:

- `server.ts` has no direct route registrations;
- route registrations appear under `apps/api/src/routes`;
- `server.ts` is substantially shorter than before extraction.

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npm test -- apps/api/src/server.test.ts
npm run typecheck
```

Expected: all API server tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/routes apps/api/src/services
git commit -m "Reduce API server entrypoint"
```

---

### Task 7: Split API Server Tests By Domain

**Files:**

- Create: `apps/api/src/server-test-utils.ts`
- Create: `apps/api/src/server.cache.test.ts`
- Create: `apps/api/src/server.jobs.test.ts`
- Create: `apps/api/src/server.jobs-delete.test.ts`
- Create: `apps/api/src/server.intake.test.ts`
- Create: `apps/api/src/server.browser.test.ts`
- Delete or reduce: `apps/api/src/server.test.ts`

- [ ] **Step 1: Create shared test utilities**

Create `apps/api/src/server-test-utils.ts`. Move the test setup from the top of `server.test.ts` into this file:

```ts
import { access } from "node:fs/promises";
import { expect, vi } from "vitest";
import type { ApiConfig } from "./config.js";
import { JobRepository, type Job } from "./jobs.js";

export const persistenceState = vi.hoisted(() => ({
  initialJobs: [] as Job[]
}));

vi.mock("./persistence.js", async () => {
  const { MemoryCacheStore } = await import("@popcorn-queue/core");
  const { JobRepository } = await import("./jobs.js");

  class CountingMemoryCacheStore<T> extends MemoryCacheStore<T> {
    countValue = 0;

    override async set(key: string, data: T) {
      const existing = await this.get(key);
      const entry = await super.set(key, data);
      if (!existing) this.countValue += 1;
      return entry;
    }

    async count(): Promise<number> {
      return this.countValue;
    }
  }

  return {
    PrismaPersistence: class {
      readonly jobs;
      readonly ptpCache = new CountingMemoryCacheStore();

      constructor(options: { jobs?: ConstructorParameters<typeof JobRepository>[1] } = {}) {
        this.jobs = new JobRepository(persistenceState.initialJobs, options.jobs);
      }

      async disconnect(): Promise<void> {}
    }
  };
});

import { buildServer } from "./server.js";

export const authHeaders = { authorization: "Bearer test-browser-token" };

export function testConfig(): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    browserToken: "test-browser-token",
    webAuth: {
      enabled: false,
      sessionCookieName: "popcorn_session",
      sessionMaxAgeSeconds: 604800
    },
    allowedOrigins: [],
    publicWebUrl: "http://localhost:5173",
    publicApiUrl: "http://localhost:3500",
    ptp: {
      apiUser: "api-user",
      apiKey: "api-key",
      username: "",
      password: "",
      baseUrl: "https://passthepopcorn.me/torrents.php",
      userAgent: "Popcorn Queue Test",
      requestDelayMs: 0,
      announceUrl: "https://please.passthepopcorn.me/passkey/announce",
      cookieFile: ""
    },
    integrations: {
      imageHost: "imgbb",
      imgbbApiKey: "imgbb-key",
      tmdbApiKey: "",
      ptpImgApiKey: "",
      qbittorrentUrl: "",
      qbittorrentUsername: "",
      qbittorrentPassword: "",
      qbittorrentTags: [],
      qbittorrentCategory: "",
      qbittorrentContentLayout: "",
      qbittorrentDownloadWaitMs: 0,
      qbittorrentDownloadPollMs: 1,
      runExternalTools: false,
      ffmpegBin: "ffmpeg",
      mediainfoBin: "mediainfo",
      mkvmergeBin: "mkvmerge",
      mpvBin: "mpv",
      oxipngBin: "oxipng",
      xvfbRunBin: "xvfb-run",
      workDir: "./data/work",
      outputDir: "./data/output"
    },
    logging: {
      level: "silent",
      file: "",
      toFile: false,
      toConsole: false
    },
    paths: {
      dataRoot: "/tmp/popcorn-queue-test-data",
      apiLogFile: "/tmp/popcorn-queue-test-api.log",
      workerLogFile: "/tmp/popcorn-queue-test-worker.log"
    }
  };
}

export async function withServer<T>(
  run: (app: ReturnType<typeof buildServer>) => Promise<T>,
  options: Parameters<typeof buildServer>[1] = { autoPrepare: false }
): Promise<T> {
  const app = buildServer(testConfig(), options);
  try {
    await app.ready();
    return await run(app);
  } finally {
    await app.close();
  }
}

export async function withConfiguredServer<T>(
  config: ApiConfig,
  options: Parameters<typeof buildServer>[1],
  run: (app: ReturnType<typeof buildServer>) => Promise<T>
): Promise<T> {
  const app = buildServer(config, options);
  try {
    await app.ready();
    return await run(app);
  } finally {
    await app.close();
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function waitForJob(app: ReturnType<typeof buildServer>, id: string, predicate: (job: Job) => boolean): Promise<Job> {
  let last: Job | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/jobs/${id}` });
    expect(response.statusCode).toBe(200);
    last = response.json<{ job: Job }>().job;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for job ${id}; last state ${last?.state ?? "unknown"}/${last?.phase ?? "unknown"}`);
}

export function multipartBody(boundary: string, fields: Record<string, string>, file: { name: string; filename: string; contentType: string; value: string }): Buffer {
  const chunks: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  chunks.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n${file.value}\r\n`
  );
  chunks.push(`--${boundary}--\r\n`);
  return Buffer.from(chunks.join(""));
}
```

If TypeScript reports unused imports after moving tests, remove only those imports.

- [ ] **Step 2: Split cache/settings/diagnostics/auth tests**

Create `apps/api/src/server.cache.test.ts`. Move these tests from `server.test.ts` into it:

- `reports permanent cache policy`
- `returns system diagnostics without worker log noise`
- `runs manual diagnostic checks without contacting missing integrations`
- `returns hot-reloadable settings without exposing secret values or restart-only keys`
- `saves settings to dotenv and hot reloads runtime configuration`
- `protects web API routes with local PTP username and password sessions`
- `reuses browser check results from permanent cache until invalidated`

Use imports from `server-test-utils.ts` instead of local helper definitions:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtpClient } from "@popcorn-queue/integrations";
import type { BrowserCheckResult, TorrentCandidate } from "@popcorn-queue/core";
import type { CommandExecutor } from "@popcorn-queue/worker";
import { authHeaders, multipartBody, persistenceState, testConfig, withConfiguredServer, withServer } from "./server-test-utils.js";
```

Remove the moved tests from `server.test.ts`.

- [ ] **Step 3: Split browser tests**

Create `apps/api/src/server.browser.test.ts`. Move these tests:

- `allows browser preflight for review draft saves`
- `allows remote dev browser origins on the configured web port for the same host as the API`
- `creates browser upload jobs from multipart submissions`
- `preserves UTF-8 uploaded torrent filenames`
- `repairs mojibake uploaded torrent filenames before storing jobs`

Use imports:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, multipartBody, persistenceState, testConfig, withConfiguredServer, withServer } from "./server-test-utils.js";
import type { Job } from "./jobs.js";
```

Remove the moved tests from `server.test.ts`.

- [ ] **Step 4: Split job lifecycle tests**

Create `apps/api/src/server.jobs.test.ts`. Move these tests:

- `returns null download status for jobs without a download snapshot`
- `resumes paused jobs through the API`
- `uses intent action routes for upload starts and keeps only skip debug routing`
- `retries completed evidence phases without rerunning unrelated completed phases`
- `automatically prepares created jobs to review when enabled`
- `resumes persisted preparing jobs after API restart`
- `imports a copied done job and marks it for reseed when qBittorrent is missing it`
- `retries needs-reseed jobs by handing the upload torrent to qBittorrent`
- `keeps restored done jobs in review when required upload files are missing`
- `patches the review draft, runs Start Upload, and hands the upload torrent to qBittorrent`
- `syncs the uploaded torrent into the PTP browser check cache before post-hook`

Use imports:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommandExecutor } from "@popcorn-queue/worker";
import { JobRepository, type Job } from "./jobs.js";
import { pathExists, persistenceState, testConfig, waitForJob, withConfiguredServer, withServer } from "./server-test-utils.js";
```

Remove the moved tests from `server.test.ts`.

- [ ] **Step 5: Split delete tests**

Create `apps/api/src/server.jobs-delete.test.ts`. Move these tests:

- `requires confirmation before deleting a job`
- `removes a job from the default queue without deleting the stored job`
- `deletes only download files and safely removes the download torrent`
- `falls back to download status info hash when deleting download files`
- `deletes the local job and cleans up download and seed torrents`

Use imports:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { JobRepository, type Job } from "./jobs.js";
import { pathExists, persistenceState, testConfig, withConfiguredServer, withServer } from "./server-test-utils.js";
```

Remove the moved tests from `server.test.ts`.

- [ ] **Step 6: Split intake tests**

Create `apps/api/src/server.intake.test.ts`. Move these tests:

- `validates manual intake media paths from arbitrary absolute locations`
- `accepts directory media paths with a warning`
- `searches PTP movies from a manual release name without creating a job`
- `resolves a manual PTP target from a PTP movie URL`
- `resolves a manual PTP target from an IMDb URL`
- `creates manual intake jobs from server media and uploaded torrent`
- `runs duplicate checks for manual intake jobs against the confirmed PTP group`
- `creates manual intake jobs from server media without a source torrent`
- `creates manual intake jobs from a torrent URL without real network`
- `decodes percent-encoded torrent URL filenames from content disposition`
- `creates manual intake jobs from a torrent URL without a server media path`
- `derives manual intake release names when no override is supplied`

Use imports:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { multipartBody, persistenceState, testConfig, waitForJob, withConfiguredServer } from "./server-test-utils.js";
import type { Job } from "./jobs.js";
```

Remove the moved tests from `server.test.ts`.

- [ ] **Step 7: Delete or shrink original `server.test.ts`**

If all tests have moved, delete `apps/api/src/server.test.ts`.

If a tiny smoke test remains useful, keep only:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { persistenceState, withServer } from "./server-test-utils.js";

describe("API server", () => {
  beforeEach(() => {
    persistenceState.initialJobs = [];
  });

  it("responds to health checks", async () => {
    await withServer(async (app) => {
      const response = await app.inject({ method: "GET", url: "/api/health" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true });
    });
  });
});
```

Prefer deleting the original file if the split files already cover health.

- [ ] **Step 8: Run split tests**

Run:

```bash
npm test -- apps/api/src/server.cache.test.ts apps/api/src/server.browser.test.ts apps/api/src/server.jobs.test.ts apps/api/src/server.jobs-delete.test.ts apps/api/src/server.intake.test.ts
npm test -- apps/api/src
npm run typecheck
```

Expected: all API tests pass and typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/server-test-utils.ts apps/api/src/server.*.test.ts apps/api/src/server.test.ts
git commit -m "Split API server tests by domain"
```

---

### Task 8: Final Verification And Documentation Check

**Files:**

- Modify only files with accidental formatting or import cleanup discovered by verification.

- [ ] **Step 1: Check final API file sizes**

Run:

```bash
wc -l apps/api/src/server.ts apps/api/src/routes/*.ts apps/api/src/services/*.ts apps/api/src/server*.test.ts
```

Expected:

- `apps/api/src/server.ts` is much smaller than the original 1258 lines;
- route files and service files are focused enough to inspect independently;
- no single new API route file is larger than the original `server.ts`.

- [ ] **Step 2: Check route placement**

Run:

```bash
rg -n "app\\.(get|post|patch|delete|put)" apps/api/src/server.ts apps/api/src/routes
```

Expected: route registrations live in `apps/api/src/routes/*.ts`; `server.ts` only has hooks/plugins and `registerApiRoutes`.

- [ ] **Step 3: Check for stale imports and obvious duplicate code**

Run:

```bash
npm run typecheck
rg -n "return jobRepository\\.markUploadResult|id: \"image-host-upload\"" apps/api/src
```

Expected:

- typecheck exits 0;
- no duplicated `return jobRepository.markUploadResult(...)` exists;
- `id: "image-host-upload"` appears once in the feature route.

- [ ] **Step 4: Run final tests**

Run:

```bash
npm test -- apps/api/src
npm test
npm run typecheck
```

Expected: all tests pass and typecheck exits 0.

- [ ] **Step 5: Check working tree**

Run:

```bash
git status --short
```

Expected: only intended API refactor files are modified.

- [ ] **Step 6: Commit final cleanup if needed**

If Step 1-5 required cleanup edits, commit them:

```bash
git add apps/api/src
git commit -m "Clean up API route refactor"
```

If no cleanup edits were needed, do not create an empty commit.
