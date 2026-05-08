# Pre-Upload Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved pre-upload automation workflow so jobs automatically prepare a copyable upload package, stop at review, and require an explicit `Start Upload` before publishing to PTP.

**Architecture:** Core owns shared phase names, upload readiness, workspace paths, manifests, and secret redaction. The worker owns media preparation and artifact-producing phase handlers. The API owns durable job state, automatic preparation orchestration, job import/reseed, global/job logs, and intent-level endpoints. The web app presents the main upload decision workbench and keeps debug controls inside Diagnostics.

**Tech Stack:** TypeScript, npm workspaces, Fastify, Prisma SQLite, React, Vite, Vitest, Playwright, pino, existing `@popcorn-queue/core`, `@popcorn-queue/worker`, and `@popcorn-queue/integrations` packages.

---

## File Structure

- Modify `packages/core/src/upload-plan.ts`: replace old phase vocabulary with the approved pre-upload lifecycle.
- Create `packages/core/src/upload-readiness.ts`: shared `UploadReadiness` type and gate/evidence readiness helper.
- Create `packages/core/src/workspace.ts`: deterministic `data/sources` and `data/jobs` paths plus manifest helpers.
- Create `packages/core/src/log-redaction.ts`: shared redaction for API, worker, and job logs.
- Modify `packages/core/src/index.ts`: export new core helpers.
- Modify `packages/core/src/upload-plan.test.ts`: assert phase vocabulary and recommended start phases.
- Create `packages/core/src/upload-readiness.test.ts`: readiness behavior.
- Create `packages/core/src/workspace.test.ts`: workspace and manifest behavior.
- Create `packages/core/src/log-redaction.test.ts`: secret redaction behavior.

- Modify `apps/worker/src/phases.ts`: rename phase handlers, split media preparation from media inspection, add image-host phase, add seed-prepare phase, and stop preparation at review.
- Create `apps/worker/src/media-prepare.ts`: hardlink/copy/remux final upload media into `media/upload`.
- Modify `apps/worker/src/phases.test.ts`: cover renamed phases, media prep, screenshots from final media, and stop-before-upload.
- Create `apps/worker/src/media-prepare.test.ts`: hardlink/copy/remux behavior without real external systems.

- Modify `packages/integrations/src/torrent-clients.ts`: implement qBittorrent client with injectable `fetch`.
- Create `packages/integrations/src/torrent-clients.test.ts`: qB add/status behavior with mocked fetch.
- Modify `packages/integrations/src/index.ts`: export torrent client classes.

- Modify `apps/api/src/jobs.ts`: durable states, upload readiness, human step, artifact summary, intent actions, import/reseed transitions.
- Modify `apps/api/src/persistence.ts`: serialize new job fields and read old rows defensively.
- Modify `apps/api/prisma/schema.prisma`: add new job columns for generated Prisma types.
- Create `apps/api/src/preparation.ts`: local automatic preparation runner that uses worker phase handlers.
- Create `apps/api/src/job-logs.ts`: per-job log file writer and log tail reader.
- Modify `apps/api/src/logger.ts`: move redaction paths to shared core helper.
- Modify `apps/api/src/config.ts`: add `dataRoot`, `globalLogDir`, worker log file paths, and qBittorrent reseed settings.
- Modify `apps/api/src/server.ts`: add intent endpoints, diagnostics endpoints, import/reseed endpoints, and automatic preparation wiring.
- Modify `apps/api/src/server.test.ts`: update API contract tests.
- Create `apps/api/src/jobs.test.ts`: repository state-machine tests.
- Create `apps/api/src/preparation.test.ts`: fake phase runner tests.
- Create `apps/api/src/job-logs.test.ts`: readable, redacted job log tests.

- Replace `apps/web/src/main.tsx` with a thin entrypoint that renders `App`.
- Create `apps/web/src/api.ts`: typed API client.
- Create `apps/web/src/types.ts`: web-facing API and UI types.
- Create `apps/web/src/App.tsx`: top-level data loading and layout state.
- Create `apps/web/src/components/QueueTable.tsx`: main queue rows and primary action rendering.
- Create `apps/web/src/components/ReviewPanel.tsx`: review sections in the approved order.
- Create `apps/web/src/components/DiagnosticsPanel.tsx`: health, full phases, logs, and debug controls.
- Modify `apps/web/src/styles.css`: keep QUI-like light shell and add review/diagnostics layout.
- Modify `apps/web/e2e/ui.spec.ts`: assert main UI hides cache/roadmap/debug text and review panel order.

- Modify `docs/api.md`, `docs/architecture.md`, `docs/manual-testing.md`, `README.md`, and `.env.example`: document new endpoints, data folders, logs, remote `0.0.0.0` defaults, and manual external-system testing.

## Task 1: Core Lifecycle Contracts

**Files:**
- Modify: `packages/core/src/upload-plan.ts`
- Create: `packages/core/src/upload-readiness.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/upload-plan.test.ts`
- Create: `packages/core/src/upload-readiness.test.ts`

- [ ] **Step 1: Write failing phase vocabulary tests**

Add these tests to `packages/core/src/upload-plan.test.ts`.

```ts
import { UPLOAD_PHASES } from "./index.js";

it("uses the pre-upload automation phase vocabulary", () => {
  expect(UPLOAD_PHASES).toEqual([
    "intake",
    "duplicate-check",
    "metadata",
    "download-or-locate",
    "prepare-media",
    "inspect-media",
    "screenshots",
    "image-host-upload",
    "torrent-create",
    "seed-prepare",
    "preflight",
    "review",
    "upload",
    "post-hook",
    "done"
  ]);
  expect(UPLOAD_PHASES).not.toContain("download");
  expect(UPLOAD_PHASES).not.toContain("extract");
  expect(UPLOAD_PHASES).not.toContain("analyze");
  expect(UPLOAD_PHASES).not.toContain("seed-start");
});

it("starts clean plans at intake and blocker plans at preflight", () => {
  const clean = buildUploadPlan({
    candidate: {
      site: "mteam",
      title: "Clean.Movie.2024.1080p.BluRay.x264-GROUP",
      imdbId: "tt7654321"
    }
  });
  expect(clean.recommendedStartPhase).toBe("intake");

  const blockedCandidate: TorrentCandidate = {
    site: "mteam",
    title: "Blocked.Movie.2024.1080p.BluRay.x264-YIFY.mp4",
    imdbId: null
  };
  const blocked = buildUploadPlan({ candidate: blockedCandidate });
  expect(blocked.recommendedStartPhase).toBe("preflight");
});
```

- [ ] **Step 2: Write failing upload readiness tests**

Create `packages/core/src/upload-readiness.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import { computeUploadReadiness, type EvidenceRequirement } from "./upload-readiness.js";
import type { ReviewGate } from "./upload-plan.js";

const blockerGate: ReviewGate = {
  id: "media:missing",
  severity: "blocker",
  status: "open",
  title: "Missing upload media",
  detail: "Final upload media was not prepared."
};

const warningGate: ReviewGate = {
  id: "scene:uncertain",
  severity: "warning",
  status: "open",
  title: "Scene check uncertain",
  detail: "Scene verification needs operator review."
};

const requiredEvidence: EvidenceRequirement = {
  id: "screenshots",
  label: "Screenshots",
  present: false,
  blocksUpload: true,
  detail: "No hosted screenshots are available."
};

describe("computeUploadReadiness", () => {
  it("blocks when an open blocker gate exists", () => {
    expect(computeUploadReadiness([blockerGate], [])).toBe("blocked");
  });

  it("reports missing evidence when blocking evidence is absent", () => {
    expect(computeUploadReadiness([warningGate], [requiredEvidence])).toBe("missing_evidence");
  });

  it("is ready when only warnings remain and blocking evidence is present", () => {
    expect(
      computeUploadReadiness([warningGate], [
        {
          ...requiredEvidence,
          present: true
        }
      ])
    ).toBe("ready");
  });
});
```

- [ ] **Step 3: Run core tests and verify they fail**

Run:

```bash
npm test -- packages/core/src/upload-plan.test.ts packages/core/src/upload-readiness.test.ts
```

Expected: FAIL because `UPLOAD_PHASES` still contains old phase names and `upload-readiness.ts` does not exist.

- [ ] **Step 4: Implement phase names and upload readiness**

In `packages/core/src/upload-plan.ts`, replace `UPLOAD_PHASES` and `recommendedPhase` with:

```ts
export const UPLOAD_PHASES = [
  "intake",
  "duplicate-check",
  "metadata",
  "download-or-locate",
  "prepare-media",
  "inspect-media",
  "screenshots",
  "image-host-upload",
  "torrent-create",
  "seed-prepare",
  "preflight",
  "review",
  "upload",
  "post-hook",
  "done"
] as const;

function recommendedPhase(gates: ReviewGate[]): UploadPhase {
  if (gates.some((gate) => gate.severity === "blocker")) return "preflight";
  return "intake";
}
```

Create `packages/core/src/upload-readiness.ts`.

```ts
import type { ReviewGate } from "./upload-plan.js";

export type UploadReadiness = "blocked" | "missing_evidence" | "ready";

export interface EvidenceRequirement {
  id: string;
  label: string;
  present: boolean;
  blocksUpload: boolean;
  detail?: string;
}

export function computeUploadReadiness(reviewGates: ReviewGate[], evidence: EvidenceRequirement[] = []): UploadReadiness {
  if (reviewGates.some((gate) => gate.status === "open" && gate.severity === "blocker")) return "blocked";
  if (evidence.some((item) => item.blocksUpload && !item.present)) return "missing_evidence";
  return "ready";
}
```

Add this export to `packages/core/src/index.ts`.

```ts
export * from "./upload-readiness.js";
```

- [ ] **Step 5: Run core tests and typecheck**

Run:

```bash
npm test -- packages/core/src/upload-plan.test.ts packages/core/src/upload-readiness.test.ts
npm --workspace @popcorn-queue/core run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/upload-plan.ts packages/core/src/upload-readiness.ts packages/core/src/index.ts packages/core/src/upload-plan.test.ts packages/core/src/upload-readiness.test.ts
git commit -m "feat(core): define pre-upload lifecycle contracts"
```

## Task 2: Workspace, Manifest, And Redaction Helpers

**Files:**
- Create: `packages/core/src/workspace.ts`
- Create: `packages/core/src/log-redaction.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/workspace.test.ts`
- Create: `packages/core/src/log-redaction.test.ts`

- [ ] **Step 1: Write failing workspace tests**

Create `packages/core/src/workspace.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { buildJobWorkspacePaths, createJobManifest } from "./workspace.js";

describe("workspace paths", () => {
  it("uses download for disposable source downloads and upload for copyable job media", () => {
    const paths = buildJobWorkspacePaths("/srv/popcorn/data", "job-123");

    expect(paths.sourceDownloadDir).toBe(path.join("/srv/popcorn/data", "sources", "job-123", "download"));
    expect(paths.jobRoot).toBe(path.join("/srv/popcorn/data", "jobs", "job-123"));
    expect(paths.mediaUploadDir).toBe(path.join(paths.jobRoot, "media", "upload"));
    expect(paths.logs.jobLog).toBe(path.join(paths.jobRoot, "logs", "job.log"));
    expect(paths.manifest).toBe(path.join(paths.jobRoot, "manifest.json"));
  });

  it("creates a copyable manifest without requiring original downloads", () => {
    const paths = buildJobWorkspacePaths("/srv/popcorn/data", "job-123");
    const manifest = createJobManifest({
      jobId: "job-123",
      createdAt: "2026-05-08T00:00:00.000Z",
      state: "review",
      source: { title: "Movie.2024.1080p.BluRay.x264-GROUP" },
      paths,
      uploadFiles: ["media/upload/Movie.2024.1080p.BluRay.x264-GROUP.mkv"],
      torrentFile: "torrent/upload.torrent",
      sourceRef: { sourceId: "source-1", originalDownloadPresent: false }
    });

    expect(manifest.version).toBe(1);
    expect(manifest.sourceRef.originalDownloadPresent).toBe(false);
    expect(manifest.uploadFiles).toEqual(["media/upload/Movie.2024.1080p.BluRay.x264-GROUP.mkv"]);
  });
});
```

- [ ] **Step 2: Write failing redaction tests**

Create `packages/core/src/log-redaction.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import { redactForLog, REDACTED_TEXT } from "./log-redaction.js";

describe("log redaction", () => {
  it("redacts nested secrets before logs are written", () => {
    const redacted = redactForLog({
      authorization: "Bearer browser-secret",
      ptp: { apiKey: "ptp-key", password: "ptp-password" },
      integrations: { imgbbApiKey: "imgbb-key", qbittorrentPassword: "qb-password" },
      safe: "visible"
    });

    expect(JSON.stringify(redacted)).not.toContain("browser-secret");
    expect(JSON.stringify(redacted)).not.toContain("ptp-key");
    expect(JSON.stringify(redacted)).not.toContain("imgbb-key");
    expect(redacted).toMatchObject({
      authorization: REDACTED_TEXT,
      ptp: { apiKey: REDACTED_TEXT, password: REDACTED_TEXT },
      integrations: { imgbbApiKey: REDACTED_TEXT, qbittorrentPassword: REDACTED_TEXT },
      safe: "visible"
    });
  });
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
npm test -- packages/core/src/workspace.test.ts packages/core/src/log-redaction.test.ts
```

Expected: FAIL because the helper modules do not exist.

- [ ] **Step 4: Implement helpers**

Create `packages/core/src/workspace.ts` with these exported names and behavior:

```ts
import path from "node:path";

export interface JobWorkspacePaths {
  dataRoot: string;
  sourceRoot: string;
  sourceDownloadDir: string;
  sourceTorrent: string;
  sourceJson: string;
  jobRoot: string;
  inputDir: string;
  mediaUploadDir: string;
  mediaIntermediatesDir: string;
  screenshotsRawDir: string;
  screenshotsOptimizedDir: string;
  screenshotsHostedJson: string;
  torrentDir: string;
  uploadTorrent: string;
  metadataDir: string;
  logs: {
    dir: string;
    jobLog: string;
    phasesJsonl: string;
    externalJsonl: string;
  };
  manifest: string;
}

export interface JobManifestInput {
  jobId: string;
  createdAt: string;
  state: string;
  source: Record<string, unknown>;
  paths: JobWorkspacePaths;
  uploadFiles: string[];
  torrentFile: string | null;
  sourceRef: {
    sourceId: string | null;
    originalDownloadPresent: boolean;
  };
}

export interface JobManifest {
  version: 1;
  jobId: string;
  createdAt: string;
  state: string;
  source: Record<string, unknown>;
  uploadFiles: string[];
  torrentFile: string | null;
  sourceRef: {
    sourceId: string | null;
    originalDownloadPresent: boolean;
  };
}

export function buildJobWorkspacePaths(dataRoot: string, jobId: string, sourceId = jobId): JobWorkspacePaths {
  const sourceRoot = path.join(dataRoot, "sources", sourceId);
  const jobRoot = path.join(dataRoot, "jobs", jobId);
  return {
    dataRoot,
    sourceRoot,
    sourceDownloadDir: path.join(sourceRoot, "download"),
    sourceTorrent: path.join(sourceRoot, "source.torrent"),
    sourceJson: path.join(sourceRoot, "source.json"),
    jobRoot,
    inputDir: path.join(jobRoot, "input"),
    mediaUploadDir: path.join(jobRoot, "media", "upload"),
    mediaIntermediatesDir: path.join(jobRoot, "media", "intermediates"),
    screenshotsRawDir: path.join(jobRoot, "screenshots", "raw"),
    screenshotsOptimizedDir: path.join(jobRoot, "screenshots", "optimized"),
    screenshotsHostedJson: path.join(jobRoot, "screenshots", "hosted.json"),
    torrentDir: path.join(jobRoot, "torrent"),
    uploadTorrent: path.join(jobRoot, "torrent", "upload.torrent"),
    metadataDir: path.join(jobRoot, "metadata"),
    logs: {
      dir: path.join(jobRoot, "logs"),
      jobLog: path.join(jobRoot, "logs", "job.log"),
      phasesJsonl: path.join(jobRoot, "logs", "phases.jsonl"),
      externalJsonl: path.join(jobRoot, "logs", "external.jsonl")
    },
    manifest: path.join(jobRoot, "manifest.json")
  };
}

export function createJobManifest(input: JobManifestInput): JobManifest {
  return {
    version: 1,
    jobId: input.jobId,
    createdAt: input.createdAt,
    state: input.state,
    source: input.source,
    uploadFiles: input.uploadFiles,
    torrentFile: input.torrentFile,
    sourceRef: input.sourceRef
  };
}
```

Create `packages/core/src/log-redaction.ts` with:

```ts
export const REDACTED_TEXT = "[redacted]";

const SECRET_KEYS = new Set([
  "authorization",
  "cookie",
  "apiKey",
  "api_key",
  "password",
  "token",
  "browserToken",
  "imgbbApiKey",
  "ptpImgApiKey",
  "qbittorrentPassword"
]);

export function redactForLog<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactForLog(item)) as T;
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEYS.has(key) ? REDACTED_TEXT : redactForLog(item);
  }
  return output as T;
}
```

Add exports:

```ts
export * from "./workspace.js";
export * from "./log-redaction.js";
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm test -- packages/core/src/workspace.test.ts packages/core/src/log-redaction.test.ts
npm --workspace @popcorn-queue/core run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/workspace.ts packages/core/src/log-redaction.ts packages/core/src/index.ts packages/core/src/workspace.test.ts packages/core/src/log-redaction.test.ts
git commit -m "feat(core): add workspace manifests and log redaction"
```

## Task 3: Worker Preparation Phases

**Files:**
- Modify: `apps/worker/src/phases.ts`
- Create: `apps/worker/src/media-prepare.ts`
- Modify: `apps/worker/src/phases.test.ts`
- Create: `apps/worker/src/media-prepare.test.ts`

- [ ] **Step 1: Write failing media preparation tests**

Create `apps/worker/src/media-prepare.test.ts`.

```ts
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandExecutor } from "./commands.js";
import { prepareUploadMedia } from "./media-prepare.js";

describe("prepareUploadMedia", () => {
  it("places uploadable MKV files in media/upload using hardlink or copy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-media-"));
    const source = path.join(root, "download", "Movie.mkv");
    await writeFile(source, "mkv");

    const result = await prepareUploadMedia({
      sourcePath: source,
      uploadDirectory: path.join(root, "job", "media", "upload"),
      intermediateDirectory: path.join(root, "job", "media", "intermediates"),
      runExternalTools: false,
      ffmpegCommand: "ffmpeg",
      commandExecutor: async () => {
        throw new Error("ffmpeg must not run for MKV hardlink/copy");
      }
    });

    expect(result.outputPath).toBe(path.join(root, "job", "media", "upload", "Movie.mkv"));
    expect(await readFile(result.outputPath, "utf8")).toBe("mkv");
    expect(["hardlink", "copy"]).toContain(result.mode);

    const inputStat = await stat(source);
    const outputStat = await stat(result.outputPath);
    if (result.mode === "hardlink") expect(outputStat.ino).toBe(inputStat.ino);
  });

  it("remuxes MP4 to MKV through the injected executor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-remux-"));
    const source = path.join(root, "download", "Movie.mp4");
    await writeFile(source, "mp4");
    const calls: string[] = [];
    const executor: CommandExecutor = async (invocation) => {
      calls.push(`${invocation.command} ${invocation.args.join(" ")}`);
      const outputPath = invocation.args.at(-1);
      if (typeof outputPath === "string") await writeFile(outputPath, "mkv");
      return {
        command: invocation.command,
        args: invocation.args,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1
      };
    };

    const result = await prepareUploadMedia({
      sourcePath: source,
      uploadDirectory: path.join(root, "job", "media", "upload"),
      intermediateDirectory: path.join(root, "job", "media", "intermediates"),
      runExternalTools: true,
      ffmpegCommand: "ffmpeg",
      commandExecutor: executor
    });

    expect(result.mode).toBe("remux");
    expect(result.outputPath.endsWith("Movie.mkv")).toBe(true);
    expect(await readFile(result.outputPath, "utf8")).toBe("mkv");
    expect(calls[0]).toContain("-c copy");
  });
});
```

- [ ] **Step 2: Write failing phase runner tests**

Add these tests to `apps/worker/src/phases.test.ts`.

```ts
it("runs preparation to review without running upload", async () => {
  const calls: CommandInvocation[] = [];
  const context = createPhaseContext(
    "job-review",
    { candidate },
    {
      runExternalTools: false,
      commandExecutor: fakeExecutor(calls)
    }
  );

  const outputs = await new PhaseRunner().runPreparationToReview(context);

  expect(outputs.review?.status).toBe("completed");
  expect(outputs.upload).toBeUndefined();
  expect(outputs.done).toBeUndefined();
});

it("uses final upload media for inspection and screenshots", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-final-media-"));
  const source = path.join(tempDir, "source", "Movie.mkv");
  await writeFile(source, "mkv");

  const context = createPhaseContext(
    "job-final-media",
    {
      candidate,
      mediaPath: source,
      workingDirectory: tempDir,
      outputDirectory: path.join(tempDir, "screens")
    },
    {
      runExternalTools: false,
      commandExecutor: fakeExecutor([])
    }
  );

  const outputs = await new PhaseRunner().runPreparationToReview(context);

  expect(outputs["prepare-media"]?.outputPath).toMatch(/media[/\\]upload[/\\]Movie\.mkv$/);
  expect(outputs["inspect-media"]?.mediaPath).toBe(outputs["prepare-media"]?.outputPath);
  expect(outputs.screenshots?.mediaPath).toBe(outputs["prepare-media"]?.outputPath);
});
```

- [ ] **Step 3: Run worker tests and verify they fail**

Run:

```bash
npm test -- apps/worker/src/phases.test.ts apps/worker/src/media-prepare.test.ts
```

Expected: FAIL because old phase names and media preparation helper are still in use.

- [ ] **Step 4: Implement media preparation helper**

Create `apps/worker/src/media-prepare.ts` with exported `prepareUploadMedia(options)`:

```ts
import { copyFile, link, mkdir } from "node:fs/promises";
import path from "node:path";
import { runCommand, type CommandExecutor } from "./commands.js";

export type PreparedMediaMode = "hardlink" | "copy" | "remux";

export interface PreparedMediaResult {
  inputPath: string;
  outputPath: string;
  mode: PreparedMediaMode;
  remuxed: boolean;
}

export interface PrepareUploadMediaOptions {
  sourcePath: string;
  uploadDirectory: string;
  intermediateDirectory: string;
  runExternalTools: boolean;
  ffmpegCommand: string;
  commandExecutor: CommandExecutor;
}

function outputName(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  return parsed.ext.toLowerCase() === ".mp4" ? `${parsed.name}.mkv` : parsed.base;
}

export async function prepareUploadMedia(options: PrepareUploadMediaOptions): Promise<PreparedMediaResult> {
  await mkdir(options.uploadDirectory, { recursive: true });
  await mkdir(options.intermediateDirectory, { recursive: true });

  const outputPath = path.join(options.uploadDirectory, outputName(options.sourcePath));
  if (path.extname(options.sourcePath).toLowerCase() === ".mp4") {
    if (!options.runExternalTools) {
      await copyFile(options.sourcePath, outputPath);
      return { inputPath: options.sourcePath, outputPath, mode: "copy", remuxed: false };
    }
    const result = await runCommand(options.commandExecutor, options.ffmpegCommand, ["-hide_banner", "-loglevel", "error", "-i", options.sourcePath, "-c", "copy", outputPath], {
      timeoutMs: 120_000
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || `ffmpeg remux failed with exit code ${result.exitCode}`);
    return { inputPath: options.sourcePath, outputPath, mode: "remux", remuxed: true };
  }

  try {
    await link(options.sourcePath, outputPath);
    return { inputPath: options.sourcePath, outputPath, mode: "hardlink", remuxed: false };
  } catch {
    await copyFile(options.sourcePath, outputPath);
    return { inputPath: options.sourcePath, outputPath, mode: "copy", remuxed: false };
  }
}
```

- [ ] **Step 5: Rename worker outputs and handlers**

In `apps/worker/src/phases.ts`:

- Replace `download` output with `download-or-locate`.
- Replace `extract` output with `prepare-media`.
- Replace `analyze` output with `inspect-media`.
- Add `image-host-upload` output that consumes screenshot files and writes hosted URLs.
- Replace `seed-start` with `seed-prepare`.
- Add `review` output.
- Update `resolvedMediaPath()` so `inspect-media` and `screenshots` use `prepare-media.outputPath`.
- Add `PhaseRunner.runPreparationToReview(context)` that runs through `review` and stops before `upload`.
- Keep `PhaseRunner.runFrom("upload", context)` for the final upload action.

Use these output field names:

```ts
"prepare-media": PhaseOutputBase & {
  inputPath: string | null;
  outputPath: string | null;
  mode: "hardlink" | "copy" | "remux" | "skipped";
  remuxed: boolean;
};
"inspect-media": PhaseOutputBase & {
  mediaPath: string | null;
  inspectionPlan: UploadPlan["media"];
  tools: Record<WorkerTool, ToolAvailability>;
  mediaInfo: CommandAttempt;
  summary: MediaInfoSummary | null;
};
"image-host-upload": PhaseOutputBase & {
  files: string[];
  hostedJsonPath: string | null;
  uploads: ImageUploadAttempt[];
};
"seed-prepare": PhaseOutputBase & {
  torrentPath: string | null;
  mediaPath: string | null;
  client: string | null;
};
review: PhaseOutputBase & {
  readyForHumanReview: true;
};
```

- [ ] **Step 6: Run worker tests and typecheck**

Run:

```bash
npm test -- apps/worker/src/phases.test.ts apps/worker/src/media-prepare.test.ts
npm --workspace @popcorn-queue/worker run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/phases.ts apps/worker/src/media-prepare.ts apps/worker/src/phases.test.ts apps/worker/src/media-prepare.test.ts
git commit -m "feat(worker): prepare upload media before review"
```

## Task 4: Durable Job State And Intent Actions

**Files:**
- Modify: `apps/api/src/jobs.ts`
- Modify: `apps/api/src/persistence.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/src/jobs.test.ts`
- Modify: `apps/api/src/server.test.ts`

- [ ] **Step 1: Write failing repository tests**

Create `apps/api/src/jobs.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import { JobRepository } from "./jobs.js";

const candidate = {
  site: "mteam" as const,
  title: "Movie.2024.1080p.BluRay.x264-GROUP",
  imdbId: "tt1234567"
};

describe("JobRepository pre-upload state machine", () => {
  it("creates jobs in preparing state with human-facing status", () => {
    const repo = new JobRepository();
    const job = repo.create({ candidate });

    expect(job.state).toBe("preparing");
    expect(job.phase).toBe("intake");
    expect(job.uploadReadiness).toBe("missing_evidence");
    expect(job.humanStep).toBe("Preparing upload package");
  });

  it("moves to review when preparation finishes and only starts upload when ready", () => {
    const repo = new JobRepository();
    let job = repo.create({ candidate });

    job = repo.markPreparedForReview(job.id, {
      uploadReadiness: "ready",
      artifacts: {
        mediaFiles: ["media/upload/Movie.2024.1080p.BluRay.x264-GROUP.mkv"],
        screenshots: ["screenshots/hosted.json"],
        mediainfo: "metadata/mediainfo.txt",
        releaseName: "metadata/release-name.txt",
        description: "metadata/description.md",
        uploadTorrent: "torrent/upload.torrent"
      }
    })!;

    expect(job.state).toBe("review");
    expect(job.humanStep).toBe("Review upload package");

    job = repo.startUpload(job.id)!;
    expect(job.state).toBe("uploading");
    expect(job.phase).toBe("upload");
  });

  it("blocks Start Upload when readiness is blocked", () => {
    const repo = new JobRepository();
    let job = repo.create({
      candidate: {
        site: "unknown",
        title: "Movie.2024.1080p.BluRay.x264-YIFY.mp4",
        imdbId: null
      }
    });

    job = repo.markPreparedForReview(job.id, { uploadReadiness: "blocked", artifacts: {} })!;
    const blocked = repo.startUpload(job.id)!;

    expect(blocked.state).toBe("review");
    expect(blocked.events[0].message).toBe("Cannot start upload until blockers and required evidence are resolved.");
  });
});
```

- [ ] **Step 2: Run repository tests and verify they fail**

Run:

```bash
npm test -- apps/api/src/jobs.test.ts
```

Expected: FAIL because `uploadReadiness`, `humanStep`, `markPreparedForReview`, and `startUpload` do not exist.

- [ ] **Step 3: Update job types and repository methods**

In `apps/api/src/jobs.ts`:

- Replace `JobState` with:

```ts
export type JobState = "created" | "preparing" | "review" | "uploading" | "paused" | "failed" | "done" | "needs_reseed" | "seeding";
```

- Replace `PhaseState` with:

```ts
export type PhaseState = "pending" | "running" | "done" | "warning" | "failed" | "skipped";
```

- Add fields to `Job`:

```ts
uploadReadiness: UploadReadiness;
humanStep: string;
artifacts: {
  mediaFiles?: string[];
  screenshots?: string[];
  mediainfo?: string;
  bdinfo?: string;
  releaseName?: string;
  description?: string;
  duplicateResult?: string;
  uploadTorrent?: string;
  qbReady?: boolean;
};
workspace?: {
  dataRoot: string;
  jobRoot: string;
  manifest: string;
};
```

- Add methods:

```ts
markPreparedForReview(id: string, input: { uploadReadiness: UploadReadiness; artifacts: Job["artifacts"] }): Job | null
startUpload(id: string): Job | null
retryFailed(id: string): Job | null
markNeedsReseed(id: string, message: string): Job | null
markReseeded(id: string, infoHash: string): Job | null
```

- Keep legacy `start`, `retry`, and `advance` as wrappers used only by old tests until server routes move to new names:

```ts
start(id: string): Job | null {
  return this.startUpload(id);
}

retry(id: string): Job | null {
  return this.retryFailed(id);
}
```

- [ ] **Step 4: Update persistence serialization**

In `apps/api/prisma/schema.prisma`, add:

```prisma
  uploadReadiness String  @default("missing_evidence") @map("upload_readiness")
  humanStep       String  @default("Preparing upload package") @map("human_step")
  artifactsJson   String  @default("{}") @map("artifacts")
  workspaceJson   String? @map("workspace")
```

In `apps/api/src/persistence.ts`, include new JSON fields in `serializeJob()` and default missing fields in `deserializeJob()`:

```ts
uploadReadiness: (row.uploadReadiness ?? "missing_evidence") as UploadReadiness,
humanStep: row.humanStep ?? "Preparing upload package",
artifacts: parseOptionalJson<Job["artifacts"]>(row.artifactsJson) ?? {},
workspace: parseOptionalJson<Job["workspace"]>(row.workspaceJson)
```

Update `JobRow` with matching camel-case Prisma fields:

```ts
uploadReadiness: string | null;
humanStep: string | null;
artifactsJson: string | null;
workspaceJson: string | null;
```

Extend `createTables()` with additive columns guarded by SQLite `ALTER TABLE` try/catch:

```ts
await this.addColumnIfMissing("Job", "upload_readiness", "TEXT NOT NULL DEFAULT 'missing_evidence'");
await this.addColumnIfMissing("Job", "human_step", "TEXT NOT NULL DEFAULT 'Preparing upload package'");
await this.addColumnIfMissing("Job", "artifacts", "TEXT NOT NULL DEFAULT '{}'");
await this.addColumnIfMissing("Job", "workspace", "TEXT");
```

Implement `addColumnIfMissing(table, column, definition)` by reading `PRAGMA table_info("Job")` and only executing `ALTER TABLE` when the column is absent.

- [ ] **Step 5: Update server tests for intent names**

In `apps/api/src/server.test.ts`, update old route assertions:

- `/api/jobs/:id/start` becomes `/api/jobs/:id/start-upload`.
- `/api/jobs/:id/retry` becomes `/api/jobs/:id/retry-failed`.
- `/api/jobs/:id/advance` becomes `/api/jobs/:id/debug/advance`.
- Expected clean creation state becomes `preparing`.

Keep compatibility tests for old routes only if they are still exposed as aliases.

- [ ] **Step 6: Run API tests and typecheck**

Run:

```bash
npm test -- apps/api/src/jobs.test.ts apps/api/src/server.test.ts
npm --workspace @popcorn-queue/api run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/jobs.ts apps/api/src/persistence.ts apps/api/prisma/schema.prisma apps/api/src/jobs.test.ts apps/api/src/server.test.ts
git commit -m "feat(api): add upload review state machine"
```

## Task 5: Automatic Preparation Runner And Per-Job Logs

**Files:**
- Modify: `apps/api/package.json`
- Modify: `package-lock.json`
- Create: `apps/api/src/preparation.ts`
- Create: `apps/api/src/job-logs.ts`
- Modify: `apps/api/src/logger.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/src/preparation.test.ts`
- Create: `apps/api/src/job-logs.test.ts`

- [ ] **Step 1: Write failing job log tests**

Create `apps/api/src/job-logs.test.ts`.

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendJobEvent, readLogTail } from "./job-logs.js";

describe("job logs", () => {
  it("writes readable redacted per-job logs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-job-log-"));
    const logFile = path.join(root, "data", "jobs", "job-1", "logs", "job.log");

    await appendJobEvent(logFile, {
      at: "2026-05-08T00:00:00.000Z",
      level: "info",
      message: "PTP check completed.",
      payload: { apiKey: "secret", decision: "open" }
    });

    const text = await readFile(logFile, "utf8");
    expect(text).toContain("PTP check completed.");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("secret");
  });

  it("reads the newest log lines first for diagnostics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-log-tail-"));
    const logFile = path.join(root, "job.log");
    for (let index = 0; index < 5; index += 1) {
      await appendJobEvent(logFile, {
        at: `2026-05-08T00:00:0${index}.000Z`,
        level: "info",
        message: `line ${index}`
      });
    }

    expect(await readLogTail(logFile, 2)).toEqual(expect.arrayContaining([expect.stringContaining("line 3"), expect.stringContaining("line 4")]));
  });
});
```

- [ ] **Step 2: Write failing preparation service tests**

Create `apps/api/src/preparation.test.ts`.

```ts
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JobRepository } from "./jobs.js";
import { PreparationService } from "./preparation.js";

describe("PreparationService", () => {
  it("runs a created job to review and writes job logs without uploading", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-prep-"));
    const jobs = new JobRepository();
    const job = jobs.create({
      candidate: {
        site: "mteam",
        title: "Movie.2024.1080p.BluRay.x264-GROUP",
        imdbId: "tt1234567"
      }
    });

    const service = new PreparationService({
      dataRoot,
      jobs,
      runExternalTools: false,
      toolCommands: { ffmpeg: "ffmpeg", mediainfo: "mediainfo", oxipng: "oxipng" }
    });

    await service.runJob(job.id);
    const prepared = jobs.get(job.id)!;

    expect(prepared.state).toBe("review");
    expect(prepared.phase).toBe("review");
    expect(prepared.uploadReadiness).not.toBe("blocked");
    expect(prepared.events.some((event) => event.message === "Upload package ready for review.")).toBe(true);
    expect(prepared.events.some((event) => event.message.includes("uploaded to PTP"))).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
npm test -- apps/api/src/job-logs.test.ts apps/api/src/preparation.test.ts
```

Expected: FAIL because the new modules do not exist.

- [ ] **Step 4: Add API dependency on worker**

Run:

```bash
npm install @popcorn-queue/worker@0.1.0 --workspace @popcorn-queue/api
```

Expected: `apps/api/package.json` gains `@popcorn-queue/worker` and `package-lock.json` is updated.

- [ ] **Step 5: Implement per-job log helpers**

Create `apps/api/src/job-logs.ts`.

```ts
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { redactForLog } from "@popcorn-queue/core";

export interface JobLogEvent {
  at: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  payload?: unknown;
}

export async function appendJobEvent(filePath: string, event: JobLogEvent): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const payload = event.payload === undefined ? "" : ` ${JSON.stringify(redactForLog(event.payload))}`;
  await import("node:fs/promises").then(({ appendFile }) => appendFile(filePath, `${event.at} ${event.level.toUpperCase()} ${event.message}${payload}\n`, "utf8"));
}

export async function readLogTail(filePath: string, lines: number): Promise<string[]> {
  try {
    const text = await readFile(filePath, "utf8");
    return text.trimEnd().split(/\r?\n/).slice(-lines);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
```

- [ ] **Step 6: Implement preparation service**

Create `apps/api/src/preparation.ts` with these behaviors:

- Build workspace paths with `buildJobWorkspacePaths(dataRoot, job.id)`.
- Create required directories.
- Run `new PhaseRunner().runPreparationToReview(context)` with `runExternalTools` from config.
- Log each phase start/finish through `appendJobEvent`.
- Convert open blocker gates plus artifact presence into `uploadReadiness`.
- Call `jobs.markPreparedForReview(job.id, { uploadReadiness, artifacts })`.
- Never call the `upload` phase.

Use this constructor shape:

```ts
export interface PreparationServiceOptions {
  dataRoot: string;
  jobs: Pick<JobRepository, "get" | "markPreparedForReview">;
  runExternalTools: boolean;
  toolCommands: Partial<Record<WorkerTool, string>>;
  imageUploader?: ImageHostUploader;
}
```

- [ ] **Step 7: Wire automatic preparation in the server**

In `apps/api/src/config.ts`, add:

```ts
paths: {
  dataRoot: resolveProjectPath(env.POPCORN_QUEUE_DATA_ROOT, "data"),
  apiLogFile: resolveProjectPath(env.POPCORN_QUEUE_LOG_FILE, "logs/api.log"),
  workerLogFile: resolveProjectPath(env.POPCORN_QUEUE_WORKER_LOG_FILE, "logs/worker.log")
}
```

In `apps/api/src/server.ts`:

- Instantiate `PreparationService`.
- After manual job creation and browser job creation, call `void preparation.enqueue(job.id)`.
- Add `BuildServerOptions` with `autoPrepare?: boolean` and default `true`.
- In tests, pass `autoPrepare: false` when asserting raw creation state and `autoPrepare: true` when asserting automatic review.
- Add endpoints:

```ts
POST /api/jobs/:id/retry-failed
POST /api/jobs/:id/start-upload
GET /api/jobs/:id/logs
GET /api/logs/global
POST /api/jobs/:id/debug/advance
POST /api/jobs/:id/debug/skip
POST /api/jobs/:id/debug/force-state
```

Keep `/api/jobs/:id/advance` as a debug alias only if current userscript or tests still call it.

- [ ] **Step 8: Run API tests and typecheck**

Run:

```bash
npm test -- apps/api/src/job-logs.test.ts apps/api/src/preparation.test.ts apps/api/src/server.test.ts
npm --workspace @popcorn-queue/api run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/package.json package-lock.json apps/api/src/preparation.ts apps/api/src/job-logs.ts apps/api/src/logger.ts apps/api/src/config.ts apps/api/src/server.ts apps/api/src/preparation.test.ts apps/api/src/job-logs.test.ts apps/api/src/server.test.ts
git commit -m "feat(api): run jobs to pre-upload review"
```

## Task 6: Import, Restore, And qBittorrent Reseed

**Files:**
- Modify: `packages/integrations/src/torrent-clients.ts`
- Modify: `packages/integrations/src/index.ts`
- Create: `packages/integrations/src/torrent-clients.test.ts`
- Modify: `apps/api/src/jobs.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/server.test.ts`

- [ ] **Step 1: Write failing qBittorrent tests**

Create `packages/integrations/src/torrent-clients.test.ts`.

```ts
import { describe, expect, it } from "vitest";
import { QBittorrentClient } from "./torrent-clients.js";

describe("QBittorrentClient", () => {
  it("logs in and adds a torrent with a save path", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      if (String(input).endsWith("/api/v2/auth/login")) return new Response("Ok.", { status: 200, headers: { "set-cookie": "SID=abc" } });
      if (String(input).endsWith("/api/v2/torrents/add")) return new Response("Ok.", { status: 200 });
      return new Response("Not found", { status: 404 });
    };

    const client = new QBittorrentClient({
      baseUrl: "http://127.0.0.1:8080",
      username: "user",
      password: "pass",
      fetchImpl
    });

    await expect(
      client.addTorrent({
        torrentPath: "/tmp/upload.torrent",
        downloadPath: "/tmp/media",
        category: "ptp",
        tags: ["ptp", "upload"]
      })
    ).resolves.toEqual({ infoHash: "" });

    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8080/api/v2/auth/login",
      "http://127.0.0.1:8080/api/v2/torrents/add"
    ]);
  });
});
```

- [ ] **Step 2: Write failing restore/reseed API tests**

Add to `apps/api/src/server.test.ts`:

```ts
it("imports a copied done job and marks it for reseed when qBittorrent is missing it", async () => {
  await withServer(async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/jobs/import",
      payload: {
        jobPath: "/tmp/popcorn-restored-job",
        manifest: {
          version: 1,
          jobId: "restored-job",
          createdAt: "2026-05-08T00:00:00.000Z",
          state: "done",
          source: { title: "Restored.Movie.2024.1080p.BluRay.x264-GROUP" },
          uploadFiles: ["media/upload/Restored.Movie.2024.1080p.BluRay.x264-GROUP.mkv"],
          torrentFile: "torrent/upload.torrent",
          sourceRef: { sourceId: "source-1", originalDownloadPresent: false }
        }
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ job: Job }>().job.state).toBe("needs_reseed");
  });
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```bash
npm test -- packages/integrations/src/torrent-clients.test.ts apps/api/src/server.test.ts
```

Expected: FAIL because qBittorrent client and import endpoint are absent.

- [ ] **Step 4: Implement qBittorrent client**

In `packages/integrations/src/torrent-clients.ts`, add `QBittorrentClient` with:

- `login()` posts to `/api/v2/auth/login`.
- `addTorrent()` posts multipart form data to `/api/v2/torrents/add`.
- `hasTorrent(infoHash)` calls `/api/v2/torrents/info?hashes=<hash>`.
- `isComplete(infoHash)` returns true only when qB reports progress `1`.
- Secrets are not included in thrown error messages.

Export the class from `packages/integrations/src/index.ts`.

- [ ] **Step 5: Implement import and reseed endpoints**

In `apps/api/src/server.ts`, add:

```ts
POST /api/jobs/import
POST /api/jobs/:id/reseed
```

`/api/jobs/import` accepts either:

- `{ "jobPath": "/absolute/path/to/job" }`, then reads `manifest.json`.
- `{ "jobPath": "/absolute/path/to/job", "manifest": { ... } }`, for tests and controlled imports.

When imported manifest state is `done`, call qB status. If qB has no torrent, set state to `needs_reseed`. If qB is not configured, keep `needs_reseed` and log `qBittorrent is not configured for automatic reseed.`

`/api/jobs/:id/reseed` pushes `torrent/upload.torrent` to qB with `media/upload` as `downloadPath`. On success call `markReseeded(id, infoHash)`. On failure keep `needs_reseed` and log `reseed failed`.

- [ ] **Step 6: Run integration and API tests**

Run:

```bash
npm test -- packages/integrations/src/torrent-clients.test.ts apps/api/src/server.test.ts
npm --workspace @popcorn-queue/integrations run typecheck
npm --workspace @popcorn-queue/api run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/integrations/src/torrent-clients.ts packages/integrations/src/index.ts packages/integrations/src/torrent-clients.test.ts apps/api/src/jobs.ts apps/api/src/server.ts apps/api/src/config.ts apps/api/src/server.test.ts
git commit -m "feat(api): import jobs and reseed restored uploads"
```

## Task 7: Main UI Review Workbench And Diagnostics

**Files:**
- Replace: `apps/web/src/main.tsx`
- Create: `apps/web/src/api.ts`
- Create: `apps/web/src/types.ts`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/components/QueueTable.tsx`
- Create: `apps/web/src/components/ReviewPanel.tsx`
- Create: `apps/web/src/components/DiagnosticsPanel.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/e2e/ui.spec.ts`

- [ ] **Step 1: Write failing Playwright assertions**

Update `apps/web/e2e/ui.spec.ts` so the desktop test asserts:

```ts
await expect(page.getByText(/PTP cache/i)).toHaveCount(0);
await expect(page.getByText(/Permanent/i)).toHaveCount(0);
await expect(page.getByText(/Upsies features/i)).toHaveCount(0);
await expect(page.getByText(/Feature status/i)).toHaveCount(0);
await expect(page.getByRole("button", { name: /Advance/i })).toHaveCount(0);
await expect(page.getByRole("button", { name: /Start Upload/i })).toBeVisible();
```

Add a review ordering test:

```ts
test("shows review sections in upload decision order", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only layout assertion.");
  await page.goto("/");

  const review = page.locator("[data-testid='review-panel']");
  const headings = await review.locator("h3").allTextContents();

  expect(headings).toEqual([
    "Blockers",
    "Warnings",
    "Duplicate/PTP Result",
    "Screenshots",
    "MediaInfo / BDInfo",
    "Release Draft",
    "Torrent / qB Readiness",
    "Recent Job Log"
  ]);
});
```

Add a diagnostics test:

```ts
test("keeps debug controls inside Diagnostics", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-desktop", "Desktop-only layout assertion.");
  await page.goto("/");
  await page.getByRole("button", { name: "Diagnostics" }).click();

  await expect(page.getByTestId("diagnostics-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Advance phase" })).toBeVisible();
  await expect(page.getByText("Global logs")).toBeVisible();
  await expect(page.getByText("Job logs")).toBeVisible();
});
```

- [ ] **Step 2: Run Playwright and verify failures**

Run:

```bash
npm run test:e2e -- --project=chromium-desktop
```

Expected: FAIL because the current UI still shows cache, feature status, and `Advance`.

- [ ] **Step 3: Split the web app into focused files**

Replace `apps/web/src/main.tsx` with:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
```

Create `apps/web/src/types.ts` containing `ApiJob`, `UploadReadiness`, `ReviewGate`, `JobLogResponse`, and UI helper types matching the API response.

Create `apps/web/src/api.ts` with `fetchJson`, `loadDashboard`, `startUpload`, `pauseJob`, `retryFailed`, `resolveGate`, `loadJobLogs`, `loadGlobalLogs`, and debug action functions.

- [ ] **Step 4: Build the main UI around upload decisions**

Create `apps/web/src/App.tsx`:

- Load jobs, health, and logs.
- Never call `/api/features`.
- Select the newest job by default.
- Render primary toolbar actions: `Start Upload`, `Pause`, `Retry failed steps`, `Diagnostics`.
- Disable `Start Upload` unless `selectedJob.uploadReadiness === "ready"`.
- Use `humanStep` for visible status.

Create `apps/web/src/components/QueueTable.tsx`:

- Columns: Status, Release, Source, Step, Blockers, Warnings, Updated, Action.
- No Cache column.
- No phase debug control.

Create `apps/web/src/components/ReviewPanel.tsx` with the exact section order from the Playwright test.

Create `apps/web/src/components/DiagnosticsPanel.tsx`:

- Hidden by default.
- Shows API health, worker health placeholder from `/api/health`, full phase list, raw logs, and debug controls.
- Contains `Advance phase`, `Skip`, and `Force state` buttons only inside this component.

- [ ] **Step 5: Update styles**

In `apps/web/src/styles.css`:

- Keep white/light gray QUI-style shell colors.
- Add stable table column widths.
- Add review section spacing without nested cards inside cards.
- Hide diagnostics panel when closed.
- Ensure mobile hides diagnostics unless explicitly opened.

- [ ] **Step 6: Run web tests and typecheck**

Run:

```bash
npm --workspace @popcorn-queue/web run typecheck
npm run test:e2e -- --project=chromium-desktop
npm run test:e2e -- --project=chromium-mobile
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/main.tsx apps/web/src/api.ts apps/web/src/types.ts apps/web/src/App.tsx apps/web/src/components/QueueTable.tsx apps/web/src/components/ReviewPanel.tsx apps/web/src/components/DiagnosticsPanel.tsx apps/web/src/styles.css apps/web/e2e/ui.spec.ts
git commit -m "feat(web): focus UI on pre-upload review"
```

## Task 8: Documentation, Environment, And Final Verification

**Files:**
- Modify: `docs/api.md`
- Modify: `docs/architecture.md`
- Modify: `docs/manual-testing.md`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `package.json`

- [ ] **Step 1: Update documentation**

Update `docs/api.md` to document:

```text
POST /api/jobs/:id/start-upload
POST /api/jobs/:id/retry-failed
POST /api/jobs/import
POST /api/jobs/:id/reseed
GET /api/jobs/:id/logs
GET /api/logs/global
POST /api/jobs/:id/debug/advance
POST /api/jobs/:id/debug/skip
POST /api/jobs/:id/debug/force-state
```

Update `docs/architecture.md` phase list to:

```text
intake -> duplicate-check -> metadata -> download-or-locate -> prepare-media -> inspect-media -> screenshots -> image-host-upload -> torrent-create -> seed-prepare -> preflight -> review -> upload -> post-hook -> done
```

Update `docs/manual-testing.md` with a manual flow:

```text
1. Start API on 0.0.0.0.
2. Start Web on 0.0.0.0.
3. Create or receive a browser job.
4. Wait for state=review.
5. Review screenshots, MediaInfo/BDInfo, duplicate result, release draft, and qB readiness.
6. Click Start Upload only after review.
7. Confirm per-job logs under data/jobs/<job-id>/logs.
```

- [ ] **Step 2: Update `.env.example`**

Ensure `.env.example` includes:

```dotenv
POPCORN_QUEUE_HOST=0.0.0.0
POPCORN_QUEUE_PORT=3500
POPCORN_QUEUE_WEB_URL=http://127.0.0.1:5173
POPCORN_QUEUE_API_URL=http://127.0.0.1:3500
POPCORN_QUEUE_DATA_ROOT=./data
POPCORN_QUEUE_LOG_TO_FILE=true
POPCORN_QUEUE_LOG_FILE=logs/api.log
POPCORN_QUEUE_WORKER_LOG_FILE=logs/worker.log
POPCORN_QUEUE_RUN_EXTERNAL_TOOLS=false
POPCORN_QUEUE_IMAGE_HOST=imgbb
IMGBB_API_KEY=
QBITTORRENT_URL=
QBITTORRENT_USERNAME=
QBITTORRENT_PASSWORD=
QBITTORRENT_CATEGORY=
QBITTORRENT_TAGS=ptp,upload
```

- [ ] **Step 3: Add log script shortcuts**

In root `package.json`, add:

```json
"logs:worker": "tail -f logs/worker.log",
"logs:job": "find data/jobs -path '*/logs/job.log' -print"
```

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
```

Expected: all commands PASS. Automated tests must use fake PTP, fake ImgBB, fake qBittorrent, and injected command executors.

- [ ] **Step 5: Start remote development servers for manual testing**

Run:

```bash
npm run dev:api
```

In a second terminal:

```bash
npm run dev:web
```

Expected:

- API listens on `0.0.0.0:3500`.
- Web listens on `0.0.0.0:5173`.
- Global logs are readable at `logs/api.log`.
- Job logs are readable at `data/jobs/<job-id>/logs/job.log`.

- [ ] **Step 6: Commit docs and verification wiring**

```bash
git add docs/api.md docs/architecture.md docs/manual-testing.md README.md .env.example package.json
git commit -m "docs: document pre-upload automation workflow"
```

## Self-Review Checklist

- Spec coverage: Tasks cover automatic preparation to review, no main UI cache display, no main UI phase debug controls, explicit `Start Upload`, `media/upload`, copyable job folders, restored-job reseed, global/per-job logs, and mocked external systems.
- Placeholder scan: The plan contains no blank task bodies, no undefined module names, and no deferred behavior.
- Type consistency: `UploadReadiness` is defined once in core and consumed by API and Web. Phase names come from `UPLOAD_PHASES`. Job states use `preparing`, `review`, `uploading`, `done`, and `needs_reseed`.
- Execution order: Core contracts land first, worker follows those contracts, API wires durable state and automation, web consumes the API, docs and full verification close the branch.
