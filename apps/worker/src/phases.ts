import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  UPLOAD_PHASES,
  buildScreenshotPlan,
  buildUploadPlan,
  type BrowserCheckResult,
  type MetadataPlan,
  type ReviewGate,
  type RuleDecision,
  type ScreenshotPlan,
  type TorrentCandidate,
  type UploadPhase,
  type UploadPlan
} from "@popcorn-queue/core";
import {
  checkWorkerTools,
  commandSucceeded,
  nodeCommandExecutor,
  runCommand,
  type CommandExecutor,
  type CommandInvocation,
  type CommandResult,
  type ToolAvailability,
  type WorkerTool
} from "./commands.js";
import { prepareUploadMedia } from "./media-prepare.js";

export { UPLOAD_PHASES };
export type { UploadPhase };

export type PhaseLogLevel = "debug" | "info" | "warn" | "error";
export type PhaseExecutionStatus = "completed" | "skipped" | "blocked" | "failed";

export interface PhaseOutputBase {
  status: PhaseExecutionStatus;
  message: string;
  producedAt: string;
}

export interface WorkerJobInput {
  candidate: TorrentCandidate;
  checkResult?: BrowserCheckResult;
  torrent?: {
    filename: string;
    bytes: number;
    contentType?: string;
    filePath?: string;
  };
  sourceTorrentPath?: string;
  mediaPath?: string;
  downloadPath?: string;
  workingDirectory?: string;
  outputDirectory?: string;
}

export interface CommandAttempt {
  invocation: CommandInvocation;
  result?: CommandResult;
  skippedReason?: string;
}

export interface MediaInfoSummary {
  durationSeconds: number | null;
  format: string | null;
  video: {
    width: number | null;
    height: number | null;
    hdrFormat: string | null;
  };
  audioTrackCount: number;
  subtitleTrackCount: number;
}

export interface ImageUploadResult {
  host: string;
  url: string;
  viewerUrl: string;
  deleteUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface ImageHostUploader {
  readonly name: string;
  uploadImage(filePath: string): Promise<ImageUploadResult>;
}

export interface ImageUploadAttempt {
  filePath: string;
  host: string | null;
  result?: ImageUploadResult;
  skippedReason?: string;
  error?: string;
}

export interface PhaseOutputMap {
  intake: PhaseOutputBase & {
    candidate: TorrentCandidate;
    uploadPlan: UploadPlan;
  };
  metadata: PhaseOutputBase & {
    plan: MetadataPlan;
    reviewGates: ReviewGate[];
  };
  "duplicate-check": PhaseOutputBase & {
    decision: RuleDecision | null;
    reviewGates: ReviewGate[];
  };
  "download-or-locate": PhaseOutputBase & {
    sourceUrl: string | null;
    downloadUrl: string | null;
    filePath: string | null;
  };
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
  screenshots: PhaseOutputBase & {
    mediaPath: string | null;
    outputDirectory: string;
    plan: ScreenshotPlan;
    tools: Pick<Record<WorkerTool, ToolAvailability>, "ffmpeg" | "oxipng">;
    ffmpeg: CommandAttempt[];
    optimizer: CommandAttempt[];
    uploads: ImageUploadAttempt[];
    files: string[];
  };
  "image-host-upload": PhaseOutputBase & {
    files: string[];
    hostedJsonPath: string | null;
    uploads: ImageUploadAttempt[];
  };
  "torrent-create": PhaseOutputBase & {
    reusePlan: UploadPlan["torrentReuse"];
    sourceTorrentPath: string | null;
  };
  "seed-prepare": PhaseOutputBase & {
    torrentPath: string | null;
    mediaPath: string | null;
    client: string | null;
  };
  preflight: PhaseOutputBase & {
    openGates: ReviewGate[];
    missingTools: WorkerTool[];
  };
  review: PhaseOutputBase & {
    readyForHumanReview: true;
  };
  upload: PhaseOutputBase & {
    ptpUrl: string | null;
    draftOnly: boolean;
  };
  "post-hook": PhaseOutputBase & {
    hooksRun: string[];
  };
  done: PhaseOutputBase & {
    completed: true;
  };
}

export type AnyPhaseOutput = PhaseOutputMap[UploadPhase];

export interface PhaseOutputStore {
  get<K extends UploadPhase>(phase: K): Promise<PhaseOutputMap[K] | undefined>;
  set<K extends UploadPhase>(phase: K, output: PhaseOutputMap[K]): Promise<void>;
  snapshot(): Partial<PhaseOutputMap>;
}

export interface PhaseContext {
  jobId: string;
  job: WorkerJobInput;
  runExternalTools: boolean;
  commandExecutor: CommandExecutor;
  toolCommands: Partial<Record<WorkerTool, string>>;
  imageUploader: ImageHostUploader | undefined;
  stopRequested(): Promise<boolean>;
  log(level: PhaseLogLevel, message: string, payload?: unknown): Promise<void>;
  getOutput<K extends UploadPhase>(phase: K): Promise<PhaseOutputMap[K] | undefined>;
  writeOutput<K extends UploadPhase>(phase: K, output: PhaseOutputMap[K]): Promise<void>;
  snapshotOutputs(): Partial<PhaseOutputMap>;
}

export interface PhaseHandler<P extends UploadPhase = UploadPhase> {
  phase: P;
  run(context: PhaseContext): Promise<PhaseOutputMap[P]>;
}

export interface CreatePhaseContextOptions {
  outputStore?: PhaseOutputStore;
  runExternalTools?: boolean;
  commandExecutor?: CommandExecutor;
  toolCommands?: Partial<Record<WorkerTool, string>>;
  imageUploader?: ImageHostUploader;
  stopRequested?: () => Promise<boolean>;
  log?: (level: PhaseLogLevel, message: string, payload?: unknown) => Promise<void>;
}

export class MemoryPhaseOutputStore implements PhaseOutputStore {
  private readonly outputs: Partial<PhaseOutputMap>;

  constructor(initialOutputs: Partial<PhaseOutputMap> = {}) {
    this.outputs = { ...initialOutputs };
  }

  async get<K extends UploadPhase>(phase: K): Promise<PhaseOutputMap[K] | undefined> {
    return this.outputs[phase] as PhaseOutputMap[K] | undefined;
  }

  async set<K extends UploadPhase>(phase: K, output: PhaseOutputMap[K]): Promise<void> {
    this.outputs[phase] = output;
  }

  snapshot(): Partial<PhaseOutputMap> {
    return { ...this.outputs };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function base(status: PhaseExecutionStatus, message: string): PhaseOutputBase {
  return {
    status,
    message,
    producedAt: nowIso()
  };
}

export function createPhaseContext(jobId: string, job: WorkerJobInput, options: CreatePhaseContextOptions = {}): PhaseContext {
  const store = options.outputStore ?? new MemoryPhaseOutputStore();
  return {
    jobId,
    job,
    runExternalTools: options.runExternalTools ?? false,
    commandExecutor: options.commandExecutor ?? nodeCommandExecutor,
    toolCommands: options.toolCommands ?? {},
    imageUploader: options.imageUploader,
    stopRequested: options.stopRequested ?? (async () => false),
    log: options.log ?? (async () => undefined),
    getOutput: <K extends UploadPhase>(phase: K) => store.get(phase),
    writeOutput: <K extends UploadPhase>(phase: K, output: PhaseOutputMap[K]) => store.set(phase, output),
    snapshotOutputs: () => store.snapshot()
  };
}

async function pathExists(filePath: string | null | undefined): Promise<boolean> {
  if (!filePath) return false;
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function uploadPlan(context: PhaseContext): Promise<UploadPlan> {
  const intake = await context.getOutput("intake");
  if (intake) return intake.uploadPlan;

  const planInput: Parameters<typeof buildUploadPlan>[0] = { candidate: context.job.candidate };
  if (context.job.checkResult) planInput.checkResult = context.job.checkResult;
  if (context.job.torrent?.bytes !== undefined) planInput.torrentBytes = context.job.torrent.bytes;
  return buildUploadPlan(planInput);
}

async function resolvedMediaPath(context: PhaseContext): Promise<string | null> {
  const preparedMedia = await context.getOutput("prepare-media");
  if (preparedMedia?.outputPath) return preparedMedia.outputPath;
  if (context.job.mediaPath) return context.job.mediaPath;
  if (context.job.downloadPath) return context.job.downloadPath;
  return null;
}

function mediaWorkspaceDirectories(context: PhaseContext): { uploadDirectory: string; intermediateDirectory: string } | null {
  if (!context.job.workingDirectory) return null;
  const root = context.job.workingDirectory;
  return {
    uploadDirectory: path.join(root, "media", "upload"),
    intermediateDirectory: path.join(root, "media", "intermediates")
  };
}

function isArchivePath(filePath: string | null): boolean {
  return Boolean(filePath && /\.(?:rar|zip|7z|tar|tgz|tar\.gz)$/i.test(filePath));
}

function mediaInfoInvocation(command: string, mediaPath: string): CommandInvocation {
  return {
    command,
    args: ["--Output=JSON", mediaPath],
    timeoutMs: 30_000
  };
}

function screenshotInvocation(command: string, mediaPath: string, timestamp: string, outputPath: string): CommandInvocation {
  return {
    command,
    args: ["-hide_banner", "-loglevel", "error", "-ss", timestamp, "-i", mediaPath, "-frames:v", "1", "-q:v", "2", outputPath],
    timeoutMs: 60_000
  };
}

function optimizerInvocation(command: string, filePath: string): CommandInvocation {
  return {
    command,
    args: ["--strip", "safe", "--opt", "2", filePath],
    timeoutMs: 30_000
  };
}

function skippedAttempt(invocation: CommandInvocation, skippedReason: string): CommandAttempt {
  return { invocation, skippedReason };
}

async function maybeRun(context: PhaseContext, invocation: CommandInvocation): Promise<CommandAttempt> {
  const options: Omit<CommandInvocation, "command" | "args"> = {};
  if (invocation.timeoutMs) options.timeoutMs = invocation.timeoutMs;
  if (invocation.cwd) options.cwd = invocation.cwd;
  if (invocation.env) options.env = invocation.env;
  const result = await runCommand(context.commandExecutor, invocation.command, invocation.args, options);
  return { invocation, result };
}

function numberFromTrack(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

export function parseMediaInfoSummary(stdout: string): MediaInfoSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  const tracks = (parsed as { media?: { track?: unknown[] } }).media?.track;
  if (!Array.isArray(tracks)) return null;
  const general = tracks.find((track) => (track as { "@type"?: string })["@type"] === "General") as Record<string, unknown> | undefined;
  const video = tracks.find((track) => (track as { "@type"?: string })["@type"] === "Video") as Record<string, unknown> | undefined;
  const audioTrackCount = tracks.filter((track) => (track as { "@type"?: string })["@type"] === "Audio").length;
  const subtitleTrackCount = tracks.filter((track) => {
    const type = (track as { "@type"?: string })["@type"];
    return type === "Text" || type === "Menu";
  }).length;
  const duration = numberFromTrack(general?.Duration);
  return {
    durationSeconds: duration,
    format: typeof general?.Format === "string" ? general.Format : null,
    video: {
      width: numberFromTrack(video?.Width),
      height: numberFromTrack(video?.Height),
      hdrFormat: typeof video?.HDR_Format === "string" ? video.HDR_Format : null
    },
    audioTrackCount,
    subtitleTrackCount
  };
}

function screenshotOutputDirectory(context: PhaseContext): string {
  if (context.job.outputDirectory) return context.job.outputDirectory;
  const root = context.job.workingDirectory ?? process.cwd();
  return path.join(root, "screenshots", context.jobId);
}

function outputScreenshotPath(outputDirectory: string, index: number): string {
  return path.join(outputDirectory, `screenshot-${index.toString().padStart(2, "0")}.png`);
}

export function createDefaultPhaseHandlers(): PhaseHandler[] {
  return [
    {
      phase: "intake",
      async run(context) {
        const planInput: Parameters<typeof buildUploadPlan>[0] = { candidate: context.job.candidate };
        if (context.job.checkResult) planInput.checkResult = context.job.checkResult;
        if (context.job.torrent?.bytes !== undefined) planInput.torrentBytes = context.job.torrent.bytes;
        return {
          ...base("completed", "Upload plan generated."),
          candidate: context.job.candidate,
          uploadPlan: buildUploadPlan(planInput)
        };
      }
    },
    {
      phase: "metadata",
      async run(context) {
        const plan = await uploadPlan(context);
        return {
          ...base("completed", "Metadata plan prepared."),
          plan: plan.metadata,
          reviewGates: plan.reviewGates
        };
      }
    },
    {
      phase: "duplicate-check",
      async run(context) {
        const plan = await uploadPlan(context);
        const decision = context.job.checkResult?.decision ?? null;
        if (!decision) {
          return {
            ...base("skipped", "No duplicate-check result was supplied; review should resolve before upload."),
            decision,
            reviewGates: plan.reviewGates
          };
        }
        return {
          ...base(decision.status === "full" ? "blocked" : "completed", decision.reason),
          decision,
          reviewGates: plan.reviewGates
        };
      }
    },
    {
      phase: "download-or-locate",
      async run(context) {
        const existingPath = context.job.downloadPath ?? context.job.mediaPath ?? null;
        return {
          ...base(existingPath ? "completed" : "skipped", existingPath ? "Media path is already available." : "Download integration is not configured in this worker scaffold."),
          sourceUrl: context.job.candidate.sourceUrl ?? null,
          downloadUrl: context.job.candidate.downloadUrl ?? null,
          filePath: existingPath
        };
      }
    },
    {
      phase: "prepare-media",
      async run(context) {
        const inputPath = context.job.mediaPath ?? context.job.downloadPath ?? null;
        if (!inputPath) {
          return {
            ...base("skipped", "No media path is available for preparation."),
            inputPath,
            outputPath: null,
            mode: "skipped",
            remuxed: false
          };
        }
        if (isArchivePath(inputPath)) {
          return {
            ...base("skipped", "Archive extraction is planned but no extractor is configured."),
            inputPath,
            outputPath: null,
            mode: "skipped",
            remuxed: false
          };
        }

        const directories = mediaWorkspaceDirectories(context);
        if (!directories) {
          return {
            ...base("skipped", "Media preparation requires a job working directory."),
            inputPath,
            outputPath: null,
            mode: "skipped",
            remuxed: false
          };
        }
        const prepared = await prepareUploadMedia({
          sourcePath: inputPath,
          uploadDirectory: directories.uploadDirectory,
          intermediateDirectory: directories.intermediateDirectory,
          runExternalTools: context.runExternalTools,
          ffmpegCommand: context.toolCommands.ffmpeg ?? "ffmpeg",
          commandExecutor: context.commandExecutor
        });
        return {
          ...base("completed", "Upload media prepared."),
          inputPath: prepared.inputPath,
          outputPath: prepared.outputPath,
          mode: prepared.mode,
          remuxed: prepared.remuxed
        };
      }
    },
    {
      phase: "inspect-media",
      async run(context) {
        const plan = await uploadPlan(context);
        const mediaPath = await resolvedMediaPath(context);
        const tools = await checkWorkerTools(context.commandExecutor, context.toolCommands);
        const invocation = mediaInfoInvocation(context.toolCommands.mediainfo ?? "mediainfo", mediaPath ?? "<media-path>");

        let mediaInfo: CommandAttempt;
        let summary: MediaInfoSummary | null = null;
        if (!context.runExternalTools) {
          mediaInfo = skippedAttempt(invocation, "External tool execution is disabled.");
        } else if (!tools.mediainfo.available) {
          mediaInfo = skippedAttempt(invocation, "mediainfo is unavailable.");
        } else if (!mediaPath || !(await pathExists(mediaPath))) {
          mediaInfo = skippedAttempt(invocation, "No existing media path is available for analysis.");
        } else {
          mediaInfo = await maybeRun(context, mediaInfoInvocation(tools.mediainfo.command, mediaPath));
          if (mediaInfo.result && commandSucceeded(mediaInfo.result)) {
            summary = parseMediaInfoSummary(mediaInfo.result.stdout);
          }
        }

        return {
          ...base("completed", mediaInfo.result ? "MediaInfo command completed." : "Media analysis plan prepared."),
          mediaPath,
          inspectionPlan: plan.media,
          tools,
          mediaInfo,
          summary
        };
      }
    },
    {
      phase: "screenshots",
      async run(context) {
        const plan = await uploadPlan(context);
        const mediaInspection = await context.getOutput("inspect-media");
        const mediaPath = await resolvedMediaPath(context);
        const screenshotPlan = buildScreenshotPlan(plan.parsed, mediaInspection?.summary?.durationSeconds ?? undefined);
        const outputDirectory = screenshotOutputDirectory(context);
        const tools = await checkWorkerTools(context.commandExecutor, context.toolCommands);
        const ffmpeg: CommandAttempt[] = [];
        const optimizer: CommandAttempt[] = [];
        const uploads: ImageUploadAttempt[] = [];
        const files = screenshotPlan.timestamps.map((timestamp) => outputScreenshotPath(outputDirectory, timestamp.index));

        for (const timestamp of screenshotPlan.timestamps) {
          const outputPath = outputScreenshotPath(outputDirectory, timestamp.index);
          const invocation = screenshotInvocation(context.toolCommands.ffmpeg ?? "ffmpeg", mediaPath ?? "<media-path>", timestamp.label, outputPath);
          if (!context.runExternalTools) {
            ffmpeg.push(skippedAttempt(invocation, "External tool execution is disabled."));
          } else if (!tools.ffmpeg.available) {
            ffmpeg.push(skippedAttempt(invocation, "ffmpeg is unavailable."));
          } else if (!mediaPath || !(await pathExists(mediaPath))) {
            ffmpeg.push(skippedAttempt(invocation, "No existing media path is available for screenshots."));
          } else {
            await mkdir(outputDirectory, { recursive: true });
            ffmpeg.push(await maybeRun(context, screenshotInvocation(tools.ffmpeg.command, mediaPath, timestamp.label, outputPath)));
          }
        }

        for (const file of files) {
          const invocation = optimizerInvocation(context.toolCommands.oxipng ?? "oxipng", file);
          const screenshotCreated = ffmpeg.some((attempt) => attempt.invocation.args.includes(file) && attempt.result && commandSucceeded(attempt.result));
          if (!context.runExternalTools) {
            optimizer.push(skippedAttempt(invocation, "External tool execution is disabled."));
          } else if (!tools.oxipng.available) {
            optimizer.push(skippedAttempt(invocation, "oxipng is unavailable."));
          } else if (!screenshotCreated) {
            optimizer.push(skippedAttempt(invocation, "Screenshot file was not created."));
          } else {
            optimizer.push(await maybeRun(context, optimizerInvocation(tools.oxipng.command, file)));
          }
        }

        for (const file of files) {
          const screenshotCreated = ffmpeg.some((attempt) => attempt.invocation.args.includes(file) && attempt.result && commandSucceeded(attempt.result));
          if (!context.runExternalTools) {
            uploads.push({ filePath: file, host: context.imageUploader?.name ?? null, skippedReason: "External upload execution is disabled." });
          } else if (!context.imageUploader) {
            uploads.push({ filePath: file, host: null, skippedReason: "Image host uploader is not configured." });
          } else if (!screenshotCreated || !(await pathExists(file))) {
            uploads.push({ filePath: file, host: context.imageUploader.name, skippedReason: "Screenshot file was not created." });
          } else {
            try {
              uploads.push({ filePath: file, host: context.imageUploader.name, result: await context.imageUploader.uploadImage(file) });
            } catch (error) {
              uploads.push({ filePath: file, host: context.imageUploader.name, error: error instanceof Error ? error.message : String(error) });
            }
          }
        }

        return {
          ...base("completed", "Screenshot plan prepared."),
          mediaPath,
          outputDirectory,
          plan: screenshotPlan,
          tools: {
            ffmpeg: tools.ffmpeg,
            oxipng: tools.oxipng
          },
          ffmpeg,
          optimizer,
          uploads,
          files
        };
      }
    },
    {
      phase: "image-host-upload",
      async run(context) {
        const screenshots = await context.getOutput("screenshots");
        if (!screenshots) {
          return {
            ...base("skipped", "No screenshots are available for image host upload."),
            files: [],
            hostedJsonPath: null,
            uploads: []
          };
        }
        const hostedUploads = screenshots.uploads
          .filter((attempt) => attempt.result)
          .map((attempt) => ({
            filePath: attempt.filePath,
            host: attempt.host,
            result: attempt.result
          }));
        let hostedJsonPath: string | null = null;
        if (hostedUploads.length > 0) {
          hostedJsonPath = path.join(screenshots.outputDirectory, "hosted.json");
          await mkdir(path.dirname(hostedJsonPath), { recursive: true });
          await writeFile(hostedJsonPath, `${JSON.stringify(hostedUploads, null, 2)}\n`, "utf8");
        }
        return {
          ...base("completed", "Image host upload results collected from screenshot phase."),
          files: screenshots.files,
          hostedJsonPath,
          uploads: screenshots.uploads
        };
      }
    },
    {
      phase: "torrent-create",
      async run(context) {
        const plan = await uploadPlan(context);
        return {
          ...base(plan.torrentReuse.canReuseImmediately ? "completed" : "skipped", plan.torrentReuse.reason),
          reusePlan: plan.torrentReuse,
          sourceTorrentPath: context.job.sourceTorrentPath ?? context.job.torrent?.filePath ?? null
        };
      }
    },
    {
      phase: "seed-prepare",
      async run(context) {
        return {
          ...base("skipped", "Torrent client integration is not configured in this worker scaffold."),
          torrentPath: context.job.sourceTorrentPath ?? context.job.torrent?.filePath ?? null,
          mediaPath: await resolvedMediaPath(context),
          client: null
        };
      }
    },
    {
      phase: "preflight",
      async run(context) {
        const plan = await uploadPlan(context);
        const mediaInspection = await context.getOutput("inspect-media");
        const screenshots = await context.getOutput("screenshots");
        const openGates = plan.reviewGates.filter((gate) => gate.status === "open");
        const missingTools: WorkerTool[] = [];
        if (mediaInspection && !mediaInspection.tools.mediainfo.available) missingTools.push("mediainfo");
        if (screenshots && !screenshots.tools.ffmpeg.available) missingTools.push("ffmpeg");
        if (screenshots && !screenshots.tools.oxipng.available) missingTools.push("oxipng");
        const hasBlocker = openGates.some((gate) => gate.severity === "blocker");
        return {
          ...base(hasBlocker ? "blocked" : "completed", hasBlocker ? "Open blocker review gates remain." : "Preflight evidence collected."),
          openGates,
          missingTools
        };
      }
    },
    {
      phase: "review",
      async run() {
        return {
          ...base("completed", "Ready for human review."),
          readyForHumanReview: true
        };
      }
    },
    {
      phase: "upload",
      async run(context) {
        return {
          ...base("skipped", "PTP upload submission is not configured in this worker scaffold."),
          ptpUrl: context.job.checkResult?.decision.ptpUrl ?? null,
          draftOnly: true
        };
      }
    },
    {
      phase: "post-hook",
      async run() {
        return {
          ...base("skipped", "No post-upload hooks are configured."),
          hooksRun: []
        };
      }
    },
    {
      phase: "done",
      async run() {
        return {
          ...base("completed", "Worker phase run complete."),
          completed: true
        };
      }
    }
  ];
}

export class PhaseRunner {
  private readonly handlers: PhaseHandler[];

  constructor(handlers: PhaseHandler[] = createDefaultPhaseHandlers()) {
    this.handlers = UPLOAD_PHASES.map((phase) => {
      const handler = handlers.find((item) => item.phase === phase);
      if (!handler) throw new Error(`Missing phase handler: ${phase}`);
      return handler;
    });
  }

  async runFrom(startPhase: UploadPhase, context: PhaseContext): Promise<Partial<PhaseOutputMap>> {
    const startIndex = this.handlers.findIndex((handler) => handler.phase === startPhase);
    if (startIndex < 0) throw new Error(`Unknown start phase: ${startPhase}`);

    for (const handler of this.handlers.slice(startIndex)) {
      if (await context.stopRequested()) {
        await context.log("info", "Stop requested before phase.", { phase: handler.phase });
        return context.snapshotOutputs();
      }

      await context.log("info", "Starting phase.", { phase: handler.phase });
      const output = await handler.run(context);
      await context.writeOutput(handler.phase, output);
      await context.log(output.status === "failed" ? "error" : output.status === "blocked" ? "warn" : "info", "Finished phase.", {
        phase: handler.phase,
        status: output.status,
        message: output.message
      });

      if (output.status === "blocked" || output.status === "failed") {
        return context.snapshotOutputs();
      }
    }

    return context.snapshotOutputs();
  }

  async runPreparationToReview(context: PhaseContext): Promise<Partial<PhaseOutputMap>> {
    const reviewIndex = this.handlers.findIndex((handler) => handler.phase === "review");
    if (reviewIndex < 0) throw new Error("Missing phase handler: review");

    for (const handler of this.handlers.slice(0, reviewIndex + 1)) {
      if (await context.stopRequested()) {
        await context.log("info", "Stop requested before phase.", { phase: handler.phase });
        return context.snapshotOutputs();
      }

      await context.log("info", "Starting phase.", { phase: handler.phase });
      const output = await handler.run(context);
      await context.writeOutput(handler.phase, output);
      await context.log(output.status === "failed" ? "error" : output.status === "blocked" ? "warn" : "info", "Finished phase.", {
        phase: handler.phase,
        status: output.status,
        message: output.message
      });

      if (output.status === "failed" || (output.status === "blocked" && handler.phase === "review")) {
        return context.snapshotOutputs();
      }
    }

    return context.snapshotOutputs();
  }
}
