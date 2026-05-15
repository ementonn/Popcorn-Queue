import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  UPLOAD_PHASES,
  buildReleaseDescription,
  buildScreenshotPlan,
  buildUploadPlan,
  createDownloadErrorStatus,
  detectMediaFeatures,
  isDownloadComplete,
  type BrowserCheckResult,
  type DownloadStatus,
  type MetadataPlan,
  type PtpUploadResult,
  type ReviewDraft,
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
import { ensurePtpSafeUploadPath, prepareUploadMedia } from "./media-prepare.js";
import { createSingleFileTorrent } from "./torrent-create.js";

export { UPLOAD_PHASES };
export type { UploadPhase };

type ScreenshotWorkerTool = Extract<WorkerTool, "ffmpeg" | "mpv" | "oxipng" | "xvfb-run">;

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
  reviewDraft?: ReviewDraft;
  torrent?: {
    filename: string;
    bytes: number;
    contentType?: string;
    filePath?: string;
  };
  sourceTorrentPath?: string;
  mediaPath?: string;
  downloadPath?: string;
  downloadDirectory?: string;
  workingDirectory?: string;
  outputDirectory?: string;
}

export interface TorrentClientFile {
  name: string;
  size: number;
  progress?: number;
}

export interface TorrentDownloadClient {
  readonly name: string;
  ping?(): Promise<void>;
  addTorrent(options: { torrentPath: string; downloadPath: string; category?: string; tags?: string[]; skipHashCheck?: boolean }): Promise<{ infoHash: string }>;
  getStatus(infoHash: string): Promise<DownloadStatus>;
  isComplete(infoHash: string): Promise<boolean>;
  listFiles(infoHash: string): Promise<TorrentClientFile[]>;
  removeTorrent?(infoHash: string, options?: { deleteData?: boolean }): Promise<void>;
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
  mediumUrl: string | null;
  width: number | null;
  height: number | null;
}

export interface ImageHostUploader {
  readonly name: string;
  uploadImage(filePath: string): Promise<ImageUploadResult>;
}

export interface PtpSubmitter {
  submit(input: { draft: ReviewDraft; torrentPath: string; nfoText?: string | null }): Promise<PtpUploadResult>;
}

export interface PtpCacheSyncInput {
  candidate: TorrentCandidate;
  checkResult?: BrowserCheckResult;
  parsed: UploadPlan["parsed"];
  releaseName: string;
  reviewDraft?: ReviewDraft;
  uploadResult: PtpUploadResult;
}

export interface PtpCacheSyncResult {
  cacheKey: string;
  groupId: string;
  torrentId: string;
  torrentCount: number;
}

export interface PtpCacheSyncer {
  syncUpload(input: PtpCacheSyncInput): Promise<PtpCacheSyncResult>;
}

export interface ImageUploadAttempt {
  filePath: string;
  host: string | null;
  result?: ImageUploadResult;
  skippedReason?: string;
  error?: string;
}

export interface PtpUploadDraft {
  releaseName: string;
  ptpUrl: string | null;
  duplicateResult: string | null;
  screenshots: string[];
  mediaInfo: string | null;
  torrentPath: string | null;
  description: string;
  descriptionPath: string | null;
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
    downloadDirectory: string | null;
    infoHash: string | null;
    client: string | null;
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
    mediaInfoText: CommandAttempt;
    mediaInfoJson: CommandAttempt;
    summary: MediaInfoSummary | null;
    features: ReturnType<typeof detectMediaFeatures>;
  };
  screenshots: PhaseOutputBase & {
    mediaPath: string | null;
    outputDirectory: string;
    plan: ScreenshotPlan;
    tools: Pick<Record<WorkerTool, ToolAvailability>, "ffmpeg" | "mpv" | "oxipng" | "xvfb-run">;
    requiredTools: ScreenshotWorkerTool[];
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
    uploadTorrentPath: string | null;
  };
  "seed-prepare": PhaseOutputBase & {
    torrentPath: string | null;
    mediaPath: string | null;
    client: string | null;
  };
  preflight: PhaseOutputBase & {
    openGates: ReviewGate[];
    missingTools: WorkerTool[];
    uploadDraft: PtpUploadDraft;
  };
  review: PhaseOutputBase & {
    readyForHumanReview: true;
  };
  upload: PhaseOutputBase & {
    ptpUrl: string | null;
    draftOnly: boolean;
    result?: PtpUploadResult;
  };
  "sync-ptp-cache": PhaseOutputBase & {
    cacheKey: string | null;
    groupId: string | null;
    torrentId: string | null;
    torrentCount: number | null;
  };
  "post-hook": PhaseOutputBase & {
    hooksRun: string[];
    infoHash: string | null;
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
  ptpSubmitter: PtpSubmitter | undefined;
  ptpCacheSyncer: PtpCacheSyncer | undefined;
  ptpAnnounceUrl: string | undefined;
  torrentClient: TorrentDownloadClient | undefined;
  torrentClientOptions: {
    category?: string;
    tags?: string[];
    waitTimeoutMs: number;
    waitIntervalMs: number;
  };
  stopRequested(): Promise<boolean>;
  log(level: PhaseLogLevel, message: string, payload?: unknown): Promise<void>;
  reportDownloadStatus(status: DownloadStatus): Promise<void>;
  onPhaseStarted(phase: UploadPhase): Promise<void>;
  onPhaseFinished(phase: UploadPhase, output: AnyPhaseOutput): Promise<void>;
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
  ptpSubmitter?: PtpSubmitter;
  ptpCacheSyncer?: PtpCacheSyncer;
  ptpAnnounceUrl?: string;
  torrentClient?: TorrentDownloadClient;
  torrentClientOptions?: {
    category?: string;
    tags?: string[];
    waitTimeoutMs?: number;
    waitIntervalMs?: number;
  };
  stopRequested?: () => Promise<boolean>;
  log?: (level: PhaseLogLevel, message: string, payload?: unknown) => Promise<void>;
  reportDownloadStatus?: (status: DownloadStatus) => Promise<void>;
  onPhaseStarted?: (phase: UploadPhase) => Promise<void>;
  onPhaseFinished?: (phase: UploadPhase, output: AnyPhaseOutput) => Promise<void>;
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
    ptpSubmitter: options.ptpSubmitter,
    ptpCacheSyncer: options.ptpCacheSyncer,
    ptpAnnounceUrl: options.ptpAnnounceUrl,
    torrentClient: options.torrentClient,
    torrentClientOptions: {
      ...(options.torrentClientOptions?.category ? { category: options.torrentClientOptions.category } : {}),
      ...(options.torrentClientOptions?.tags ? { tags: options.torrentClientOptions.tags } : {}),
      waitTimeoutMs: options.torrentClientOptions?.waitTimeoutMs ?? 0,
      waitIntervalMs: options.torrentClientOptions?.waitIntervalMs ?? 1000
    },
    stopRequested: options.stopRequested ?? (async () => false),
    log: options.log ?? (async () => undefined),
    reportDownloadStatus: options.reportDownloadStatus ?? (async () => undefined),
    onPhaseStarted: options.onPhaseStarted ?? (async () => undefined),
    onPhaseFinished: options.onPhaseFinished ?? (async () => undefined),
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

function isMediaPath(filePath: string): boolean {
  return /\.(?:mkv|mp4|m4v|mov|avi|ts|m2ts|iso)$/i.test(filePath);
}

async function collectMediaFiles(directory: string): Promise<Array<{ filePath: string; size: number }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectMediaFiles(entryPath);
    if (!entry.isFile() || !isMediaPath(entry.name)) return [];
    const info = await stat(entryPath);
    return [{ filePath: entryPath, size: info.size }];
  }));
  return files.flat();
}

async function resolveMediaFilePath(inputPath: string): Promise<string | null> {
  const info = await stat(inputPath);
  if (!info.isDirectory()) return inputPath;

  const files = await collectMediaFiles(inputPath);
  return files.sort((a, b) => b.size - a.size)[0]?.filePath ?? null;
}

async function resolveExistingMediaPath(inputPath: string | null | undefined): Promise<string | null> {
  if (!inputPath) return null;
  try {
    const info = await stat(inputPath);
    if (info.isDirectory()) return resolveMediaFilePath(inputPath);
    return isMediaPath(inputPath) ? inputPath : null;
  } catch {
    return null;
  }
}

function defaultDownloadDirectory(context: PhaseContext): string | null {
  if (context.job.downloadDirectory) return context.job.downloadDirectory;
  if (context.job.workingDirectory) return path.join(context.job.workingDirectory, "download");
  return null;
}

function sourceTorrentPath(context: PhaseContext): string | null {
  return context.job.sourceTorrentPath ?? context.job.torrent?.filePath ?? null;
}

function uploadTorrentPath(context: PhaseContext): string | null {
  if (!context.job.workingDirectory) return null;
  return path.join(context.job.workingDirectory, "torrent", "upload.torrent");
}

async function createPtpUploadTorrent(context: PhaseContext): Promise<string | null> {
  const outputPath = uploadTorrentPath(context);
  const mediaPath = await resolvedMediaPath(context);
  if (!context.ptpAnnounceUrl || !outputPath || !mediaPath || !(await pathExists(mediaPath))) return null;
  const safeMediaPath = await ensurePtpSafeUploadPath(mediaPath);
  await createSingleFileTorrent({
    inputPath: safeMediaPath,
    outputPath,
    announceUrl: context.ptpAnnounceUrl
  });
  return outputPath;
}

function selectMainMediaFile(files: TorrentClientFile[]): TorrentClientFile | null {
  return files
    .filter((file) => isMediaPath(file.name))
    .sort((a, b) => b.size - a.size)[0] ?? null;
}

async function waitForTorrentComplete(context: PhaseContext, infoHash: string): Promise<DownloadStatus | null> {
  const deadline = Date.now() + context.torrentClientOptions.waitTimeoutMs;
  do {
    const status = await context.torrentClient!.getStatus(infoHash);
    await context.reportDownloadStatus(status);
    if (isDownloadComplete(status)) return status;
    if (context.torrentClientOptions.waitTimeoutMs <= 0 || Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, context.torrentClientOptions.waitIntervalMs));
  } while (Date.now() < deadline);
  return null;
}

async function locateDownloadedTorrentMedia(status: DownloadStatus, files: TorrentClientFile[], downloadDirectory: string): Promise<string | null> {
  const contentMediaPath = await resolveExistingMediaPath(status.contentPath);
  if (contentMediaPath) return contentMediaPath;

  const mainFile = selectMainMediaFile(files);
  if (!mainFile) return null;

  const candidatePaths = [
    status.contentPath ? path.join(status.contentPath, mainFile.name) : null,
    status.contentPath ? path.join(path.dirname(status.contentPath), mainFile.name) : null,
    status.savePath ? path.join(status.savePath, mainFile.name) : null,
    path.join(downloadDirectory, mainFile.name)
  ];
  const uniqueCandidates = [...new Set(candidatePaths.filter((candidate): candidate is string => Boolean(candidate)))];
  for (const candidate of uniqueCandidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return uniqueCandidates.at(-1) ?? null;
}

export function mediaInfoTextInvocation(command: string, mediaPath: string): CommandInvocation {
  return {
    command,
    args: [mediaPath],
    timeoutMs: 30_000
  };
}

export function mediaInfoJsonInvocation(command: string, mediaPath: string): CommandInvocation {
  return {
    command,
    args: ["--Output=JSON", mediaPath],
    timeoutMs: 30_000
  };
}

export function sanitizeMediaInfoText(text: string, uploadRoot: string): string {
  const normalizedRoot = uploadRoot.replace(/[/\\]+$/, "");
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^(\s*Complete name\s*:\s*)(.+)$/);
      if (!match) return line;
      const value = (match[2] ?? "").trim();
      const normalizedValue = value.replace(/\\/g, "/");
      const normalizedPrefix = normalizedRoot.replace(/\\/g, "/");
      if (!normalizedValue.startsWith(`${normalizedPrefix}/`)) return line;
      return `${match[1] ?? ""}${normalizedValue.slice(normalizedPrefix.length + 1)}`;
    })
    .join("\n");
}

function screenshotVideoFilter(toneMapHint: ScreenshotPlan["toneMapHint"], tonemap: boolean): string {
  const scale = ["'max(sar,1)*iw'", "'max(1/sar,1)*ih'"];
  if (toneMapHint === "bt2020") {
    scale.push("in_h_chr_pos=0", "in_v_chr_pos=0", "in_color_matrix=bt2020");
  } else if (toneMapHint === "bt709") {
    scale.push("in_h_chr_pos=0", "in_v_chr_pos=128", "in_color_matrix=bt709");
  }
  scale.push("flags=full_chroma_int+full_chroma_inp+accurate_rnd+spline");
  const filters = [`scale=${scale.join(":")}`];
  if (tonemap) filters.push("zscale=t=linear", "tonemap=hable", "zscale=t=bt709", "format=rgb24");
  return filters.join(",");
}

function isHdrTonemappable(hdrFormats: readonly string[]): boolean {
  return hdrFormats.some((format) => /^HDR/i.test(format));
}

function isDolbyVision(hdrFormats: readonly string[]): boolean {
  return hdrFormats.some((format) => /^DV$/i.test(format) || /DOVI|Dolby Vision/i.test(format));
}

function requiredScreenshotTools(hdrFormats: readonly string[]): ScreenshotWorkerTool[] {
  return isDolbyVision(hdrFormats) ? ["mpv", "xvfb-run", "oxipng"] : ["ffmpeg", "oxipng"];
}

function screenshotInvocation(
  command: string,
  mediaPath: string,
  timestamp: string,
  outputPath: string,
  options: { toneMapHint: ScreenshotPlan["toneMapHint"]; tonemap: boolean }
): CommandInvocation {
  return {
    command,
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-ss",
      timestamp,
      "-i",
      mediaPath,
      "-vf",
      screenshotVideoFilter(options.toneMapHint, options.tonemap),
      "-pix_fmt",
      "rgb24",
      "-frames:v",
      "1",
      outputPath
    ],
    timeoutMs: 60_000
  };
}

function quoteMpvCommandString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

function mpvGpuNextScreenshotInvocation(xvfbRunCommand: string, mpvCommand: string, mediaPath: string, timestamp: string, outputPath: string): CommandInvocation {
  return {
    command: xvfbRunCommand,
    args: [
      "-a",
      mpvCommand,
      "--no-config",
      "--no-audio",
      "--no-sub",
      "--vo=gpu-next",
      "--gpu-context=x11egl",
      "--gpu-sw=yes",
      "--screenshot-format=png",
      "--screenshot-high-bit-depth=no",
      "--screenshot-png-compression=9",
      "--target-prim=bt.709",
      "--target-trc=srgb",
      "--target-gamut=bt.709",
      "--target-peak=203",
      "--tone-mapping=hable",
      "--gamut-mapping-mode=auto",
      `--start=${timestamp}`,
      "--pause",
      `--input-commands=screenshot-to-file ${quoteMpvCommandString(outputPath)} video; quit`,
      mediaPath
    ],
    timeoutMs: 90_000
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

function attemptTargetsFile(attempt: CommandAttempt, filePath: string): boolean {
  return attempt.invocation.args.some((arg) => arg.includes(filePath));
}

function screenshotFailureDetail(attempts: CommandAttempt[]): string | null {
  const failed = attempts.find((attempt) => attempt.result && !commandSucceeded(attempt.result));
  if (failed?.result?.error?.message) return failed.result.error.message;
  const stderr = failed?.result?.stderr.trim();
  if (stderr) return stderr.split(/\r?\n/)[0] ?? stderr;
  const skipped = attempts.find((attempt) => attempt.skippedReason);
  return skipped?.skippedReason ?? null;
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

function descriptionPath(context: PhaseContext): string | null {
  if (!context.job.workingDirectory) return null;
  return path.join(context.job.workingDirectory, "metadata", "description.md");
}

function mediaInfoUploadRoot(context: PhaseContext, mediaPath: string): string {
  const directories = mediaWorkspaceDirectories(context);
  if (directories && mediaPath.replace(/\\/g, "/").startsWith(directories.uploadDirectory.replace(/\\/g, "/"))) {
    return directories.uploadDirectory;
  }
  return path.dirname(mediaPath);
}

function sanitizeMediaInfoAttempt(attempt: CommandAttempt, uploadRoot: string): CommandAttempt {
  if (!attempt.result || !commandSucceeded(attempt.result)) return attempt;
  return {
    ...attempt,
    result: {
      ...attempt.result,
      stdout: sanitizeMediaInfoText(attempt.result.stdout, uploadRoot)
    }
  };
}

async function buildPtpUploadDraft(context: PhaseContext): Promise<PtpUploadDraft> {
  const plan = await uploadPlan(context);
  const duplicate = await context.getOutput("duplicate-check");
  const mediaInspection = await context.getOutput("inspect-media");
  const imageHost = await context.getOutput("image-host-upload");
  const torrentCreate = await context.getOutput("torrent-create");
  const screenshots = imageHost?.uploads.flatMap((attempt) => (attempt.result?.url ? [attempt.result.url] : [])) ?? [];
  const mediaInfo = mediaInspection?.mediaInfoText.result?.stdout ?? mediaInspection?.mediaInfo.result?.stdout ?? null;
  const torrentPath = torrentCreate?.uploadTorrentPath ?? null;
  const draftPath = descriptionPath(context);
  const descriptionInput: Parameters<typeof buildReleaseDescription>[0] = {
    screenshots
  };
  if (mediaInfo) descriptionInput.mediaInfoText = mediaInfo;
  const description = buildReleaseDescription(descriptionInput);

  if (draftPath) {
    await mkdir(path.dirname(draftPath), { recursive: true });
    await writeFile(draftPath, `${description}\n`, "utf8");
  }

  return {
    releaseName: plan.releaseName.generated,
    ptpUrl: context.job.checkResult?.decision.ptpUrl ?? null,
    duplicateResult: duplicate?.decision?.reason ?? context.job.checkResult?.decision.reason ?? null,
    screenshots,
    mediaInfo,
    torrentPath,
    description,
    descriptionPath: draftPath
  };
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
        const downloadDirectory = defaultDownloadDirectory(context);
        const torrentPath = sourceTorrentPath(context);
        if (existingPath) {
          return {
            ...base("completed", "Media path is already available."),
            sourceUrl: context.job.candidate.sourceUrl ?? null,
            downloadUrl: context.job.candidate.downloadUrl ?? null,
            filePath: existingPath,
            downloadDirectory,
            infoHash: null,
            client: null
          };
        }
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
        if (!downloadDirectory) {
          return {
            ...base("skipped", "Download location requires a job working directory."),
            sourceUrl: context.job.candidate.sourceUrl ?? null,
            downloadUrl: context.job.candidate.downloadUrl ?? null,
            filePath: null,
            downloadDirectory,
            infoHash: null,
            client: context.torrentClient.name
          };
        }

        try {
          await mkdir(downloadDirectory, { recursive: true });
          const addOptions: Parameters<TorrentDownloadClient["addTorrent"]>[0] = {
            torrentPath,
            downloadPath: downloadDirectory
          };
          if (context.torrentClientOptions.category) addOptions.category = context.torrentClientOptions.category;
          if (context.torrentClientOptions.tags?.length) addOptions.tags = context.torrentClientOptions.tags;
          const { infoHash } = await context.torrentClient.addTorrent(addOptions);
          const completeStatus = await waitForTorrentComplete(context, infoHash);
          if (!completeStatus) {
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
          const filePath = await locateDownloadedTorrentMedia(completeStatus, files, downloadDirectory);
          const located = filePath ? await pathExists(filePath) : false;
          return {
            ...base(located ? "completed" : "blocked", located ? "Downloaded media located." : "No media file was found in torrent contents."),
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
      }
    },
    {
      phase: "prepare-media",
      async run(context) {
        const download = await context.getOutput("download-or-locate");
        const inputPath = context.job.mediaPath ?? context.job.downloadPath ?? download?.filePath ?? null;
        if (!inputPath) {
          return {
            ...base("skipped", "No media path is available for preparation."),
            inputPath,
            outputPath: null,
            mode: "skipped",
            remuxed: false
          };
        }
        const sourcePath = await resolveMediaFilePath(inputPath);
        if (!sourcePath) {
          return {
            ...base("blocked", "No media file was found in the selected directory."),
            inputPath,
            outputPath: null,
            mode: "skipped",
            remuxed: false
          };
        }
        if (isArchivePath(sourcePath)) {
          return {
            ...base("skipped", "Archive extraction is planned but no extractor is configured."),
            inputPath: sourcePath,
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
          sourcePath,
          uploadDirectory: directories.uploadDirectory,
          intermediateDirectory: directories.intermediateDirectory,
          runExternalTools: context.runExternalTools,
          mkvmergeCommand: context.toolCommands.mkvmerge ?? "mkvmerge",
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
        const textInvocation = mediaInfoTextInvocation(context.toolCommands.mediainfo ?? "mediainfo", mediaPath ?? "<media-path>");
        const jsonInvocation = mediaInfoJsonInvocation(context.toolCommands.mediainfo ?? "mediainfo", mediaPath ?? "<media-path>");

        let mediaInfoText: CommandAttempt;
        let mediaInfoJson: CommandAttempt;
        let summary: MediaInfoSummary | null = null;
        if (!context.runExternalTools) {
          mediaInfoText = skippedAttempt(textInvocation, "External tool execution is disabled.");
          mediaInfoJson = skippedAttempt(jsonInvocation, "External tool execution is disabled.");
        } else if (!tools.mediainfo.available) {
          mediaInfoText = skippedAttempt(textInvocation, "mediainfo is unavailable.");
          mediaInfoJson = skippedAttempt(jsonInvocation, "mediainfo is unavailable.");
        } else if (!mediaPath || !(await pathExists(mediaPath))) {
          mediaInfoText = skippedAttempt(textInvocation, "No existing media path is available for analysis.");
          mediaInfoJson = skippedAttempt(jsonInvocation, "No existing media path is available for analysis.");
        } else {
          mediaInfoText = sanitizeMediaInfoAttempt(await maybeRun(context, mediaInfoTextInvocation(tools.mediainfo.command, mediaPath)), mediaInfoUploadRoot(context, mediaPath));
          mediaInfoJson = await maybeRun(context, mediaInfoJsonInvocation(tools.mediainfo.command, mediaPath));
          if (mediaInfoJson.result && commandSucceeded(mediaInfoJson.result)) {
            summary = parseMediaInfoSummary(mediaInfoJson.result.stdout);
          }
        }

        return {
          ...base("completed", mediaInfoText.result || mediaInfoJson.result ? "MediaInfo command completed." : "Media analysis plan prepared."),
          mediaPath,
          inspectionPlan: plan.media,
          tools,
          mediaInfo: mediaInfoText,
          mediaInfoText,
          mediaInfoJson,
          summary,
          features: detectMediaFeatures({
            mediaInfoJson: mediaInfoJson.result?.stdout ?? null,
            releaseName: plan.releaseName.generated || context.job.candidate.title
          })
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
        const useMpv = isDolbyVision(plan.parsed.hdr);
        const requiredTools = requiredScreenshotTools(plan.parsed.hdr);
        const screenshotOptions = {
          toneMapHint: screenshotPlan.toneMapHint,
          tonemap: isHdrTonemappable(plan.parsed.hdr)
        };

        for (const timestamp of screenshotPlan.timestamps) {
          const outputPath = outputScreenshotPath(outputDirectory, timestamp.index);
          const invocation = useMpv
            ? mpvGpuNextScreenshotInvocation(context.toolCommands["xvfb-run"] ?? "xvfb-run", context.toolCommands.mpv ?? "mpv", mediaPath ?? "<media-path>", timestamp.label, outputPath)
            : screenshotInvocation(context.toolCommands.ffmpeg ?? "ffmpeg", mediaPath ?? "<media-path>", timestamp.label, outputPath, screenshotOptions);
          if (!context.runExternalTools) {
            ffmpeg.push(skippedAttempt(invocation, "External tool execution is disabled."));
          } else if (useMpv && !tools.mpv.available) {
            ffmpeg.push(skippedAttempt(invocation, "mpv is unavailable."));
          } else if (useMpv && !tools["xvfb-run"].available) {
            ffmpeg.push(skippedAttempt(invocation, "xvfb-run is unavailable."));
          } else if (!useMpv && !tools.ffmpeg.available) {
            ffmpeg.push(skippedAttempt(invocation, "ffmpeg is unavailable."));
          } else if (!mediaPath || !(await pathExists(mediaPath))) {
            ffmpeg.push(skippedAttempt(invocation, "No existing media path is available for screenshots."));
          } else {
            await mkdir(outputDirectory, { recursive: true });
            ffmpeg.push(
              await maybeRun(
                context,
                useMpv
                  ? mpvGpuNextScreenshotInvocation(tools["xvfb-run"].command, tools.mpv.command, mediaPath, timestamp.label, outputPath)
                  : screenshotInvocation(tools.ffmpeg.command, mediaPath, timestamp.label, outputPath, screenshotOptions)
              )
            );
          }
        }

        for (const file of files) {
          const invocation = optimizerInvocation(context.toolCommands.oxipng ?? "oxipng", file);
          const screenshotCreated = ffmpeg.some((attempt) => attemptTargetsFile(attempt, file) && attempt.result && commandSucceeded(attempt.result));
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
          const screenshotCreated = ffmpeg.some((attempt) => attemptTargetsFile(attempt, file) && attempt.result && commandSucceeded(attempt.result));
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

        const missingScreenshots = context.runExternalTools
          ? (
              await Promise.all(
                files.map(async (file) => {
                  const captureSucceeded = ffmpeg.some((attempt) => attemptTargetsFile(attempt, file) && attempt.result && commandSucceeded(attempt.result));
                  return captureSucceeded && (await pathExists(file)) ? null : file;
                })
              )
            ).filter((file): file is string => Boolean(file))
          : [];
        const captureFailed = missingScreenshots.length > 0;
        const captureFailureDetail = captureFailed ? screenshotFailureDetail(ffmpeg) : null;

        return {
          ...base(captureFailed ? "failed" : "completed", captureFailed ? `Screenshot capture failed${captureFailureDetail ? `: ${captureFailureDetail}` : ` for ${missingScreenshots.length} file(s).`}` : "Screenshot plan prepared."),
          mediaPath,
          outputDirectory,
          plan: screenshotPlan,
          tools: {
            ffmpeg: tools.ffmpeg,
            mpv: tools.mpv,
            oxipng: tools.oxipng,
            "xvfb-run": tools["xvfb-run"]
          },
          requiredTools,
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
        const uploads: ImageUploadAttempt[] = [];
        for (const attempt of screenshots.uploads) {
          if (attempt.result) {
            uploads.push({
              filePath: attempt.filePath,
              host: attempt.host,
              result: attempt.result
            });
            continue;
          }
          if (!context.runExternalTools) {
            uploads.push({ filePath: attempt.filePath, host: context.imageUploader?.name ?? attempt.host, skippedReason: "External upload execution is disabled." });
          } else if (!context.imageUploader) {
            uploads.push({ filePath: attempt.filePath, host: null, skippedReason: "Image host uploader is not configured." });
          } else if (!(await pathExists(attempt.filePath))) {
            uploads.push({ filePath: attempt.filePath, host: context.imageUploader.name, skippedReason: "Screenshot file was not created." });
          } else {
            try {
              uploads.push({ filePath: attempt.filePath, host: context.imageUploader.name, result: await context.imageUploader.uploadImage(attempt.filePath) });
            } catch (error) {
              uploads.push({ filePath: attempt.filePath, host: context.imageUploader.name, error: error instanceof Error ? error.message : String(error) });
            }
          }
        }
        const hostedUploads = uploads
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
          uploads
        };
      }
    },
    {
      phase: "torrent-create",
      async run(context) {
        const plan = await uploadPlan(context);
        const sourcePath = sourceTorrentPath(context);
        const outputPath = uploadTorrentPath(context);
        const ptpTorrentPath = await createPtpUploadTorrent(context);
        if (ptpTorrentPath) {
          return {
            ...base("completed", "PTP upload torrent created from final media."),
            reusePlan: plan.torrentReuse,
            sourceTorrentPath: sourcePath,
            uploadTorrentPath: ptpTorrentPath
          };
        }

        let copiedPath: string | null = null;
        if (sourcePath && outputPath && (await pathExists(sourcePath))) {
          await mkdir(path.dirname(outputPath), { recursive: true });
          await copyFile(sourcePath, outputPath);
          copiedPath = outputPath;
        }
        return {
          ...base(copiedPath ? "completed" : plan.torrentReuse.canReuseImmediately ? "skipped" : "skipped", copiedPath ? "Upload torrent prepared from source torrent." : plan.torrentReuse.reason),
          reusePlan: plan.torrentReuse,
          sourceTorrentPath: sourcePath,
          uploadTorrentPath: copiedPath
        };
      }
    },
    {
      phase: "seed-prepare",
      async run(context) {
        const torrentCreate = await context.getOutput("torrent-create");
        const mediaPath = await resolvedMediaPath(context);
        return {
          ...base(context.torrentClient && torrentCreate?.uploadTorrentPath && mediaPath ? "completed" : "skipped", context.torrentClient ? "Torrent client is configured for handoff." : "Torrent client integration is not configured in this worker scaffold."),
          torrentPath: torrentCreate?.uploadTorrentPath ?? sourceTorrentPath(context),
          mediaPath,
          client: context.torrentClient?.name ?? null
        };
      }
    },
    {
      phase: "preflight",
      async run(context) {
        const plan = await uploadPlan(context);
        const mediaInspection = await context.getOutput("inspect-media");
        const screenshots = await context.getOutput("screenshots");
        const uploadDraft = await buildPtpUploadDraft(context);
        const openGates = plan.reviewGates.filter((gate) => gate.status === "open");
        const missingTools: WorkerTool[] = [];
        if (mediaInspection && !mediaInspection.tools.mediainfo.available) missingTools.push("mediainfo");
        for (const tool of screenshots?.requiredTools ?? (screenshots ? (["ffmpeg", "oxipng"] as ScreenshotWorkerTool[]) : [])) {
          if (!screenshots?.tools[tool]?.available && !missingTools.includes(tool)) missingTools.push(tool);
        }
        const hasBlocker = openGates.some((gate) => gate.severity === "blocker");
        return {
          ...base(hasBlocker ? "blocked" : "completed", hasBlocker ? "Open blocker review gates remain." : "Preflight evidence collected."),
          openGates,
          missingTools,
          uploadDraft
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
        if (!context.ptpSubmitter) {
          return {
            ...base("failed", "PTP submitter is not configured."),
            ptpUrl: null,
            draftOnly: true
          };
        }
        if (!context.job.reviewDraft) {
          return {
            ...base("failed", "Review draft is missing."),
            ptpUrl: null,
            draftOnly: true
          };
        }
        try {
          await createPtpUploadTorrent(context);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            ...base("failed", `PTP upload torrent could not be created: ${message}`),
            ptpUrl: null,
            draftOnly: true
          };
        }
        const torrentPath = uploadTorrentPath(context);
        if (!torrentPath || !(await pathExists(torrentPath))) {
          return {
            ...base("failed", "PTP upload torrent is missing."),
            ptpUrl: null,
            draftOnly: true
          };
        }
        const preflight = await context.getOutput("preflight");
        try {
          const result = await context.ptpSubmitter.submit({
            draft: context.job.reviewDraft,
            torrentPath,
            nfoText: preflight?.uploadDraft.mediaInfo ?? null
          });
          return {
            ...base("completed", "PTP upload submitted."),
            ptpUrl: result.ptpUrl,
            draftOnly: false,
            result
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            ...base("failed", message),
            ptpUrl: null,
            draftOnly: false
          };
        }
      }
    },
    {
      phase: "sync-ptp-cache",
      async run(context) {
        const upload = await context.getOutput("upload");
        if (upload?.status !== "completed" || !upload.result) {
          return {
            ...base("skipped", "PTP upload did not complete; cache sync was skipped."),
            cacheKey: null,
            groupId: null,
            torrentId: null,
            torrentCount: null
          };
        }
        if (!context.ptpCacheSyncer) {
          return {
            ...base("skipped", "PTP cache sync is not configured."),
            cacheKey: null,
            groupId: upload.result.groupId,
            torrentId: upload.result.torrentId,
            torrentCount: null
          };
        }

        try {
          const plan = await uploadPlan(context);
          const result = await context.ptpCacheSyncer.syncUpload({
            candidate: context.job.candidate,
            ...(context.job.checkResult ? { checkResult: context.job.checkResult } : {}),
            parsed: plan.parsed,
            releaseName: context.job.reviewDraft?.releaseName ?? plan.releaseName.generated,
            ...(context.job.reviewDraft ? { reviewDraft: context.job.reviewDraft } : {}),
            uploadResult: upload.result
          });
          return {
            ...base("completed", "PTP duplicate cache synced with uploaded torrent."),
            cacheKey: result.cacheKey,
            groupId: result.groupId,
            torrentId: result.torrentId,
            torrentCount: result.torrentCount
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            ...base("failed", `PTP cache sync failed: ${message}`),
            cacheKey: null,
            groupId: upload.result.groupId,
            torrentId: upload.result.torrentId,
            torrentCount: null
          };
        }
      }
    },
    {
      phase: "post-hook",
      async run(context) {
        const upload = await context.getOutput("upload");
        if (upload?.status !== "completed" || !upload.result) {
          return {
            ...base("skipped", "PTP upload did not complete; post-upload hooks were skipped."),
            hooksRun: [],
            infoHash: null
          };
        }
        if (!context.torrentClient) {
          return {
            ...base("skipped", "Torrent client integration is not configured for seed handoff."),
            hooksRun: [],
            infoHash: null
          };
        }

        const torrentPath = uploadTorrentPath(context);
        const mediaPath = await resolvedMediaPath(context);
        const downloadPath = mediaPath ? path.dirname(mediaPath) : mediaWorkspaceDirectories(context)?.uploadDirectory ?? null;
        if (!torrentPath || !(await pathExists(torrentPath))) {
          return {
            ...base("failed", "PTP upload torrent is missing for seed handoff."),
            hooksRun: [],
            infoHash: null
          };
        }
        if (!downloadPath) {
          return {
            ...base("failed", "Upload media directory is missing for seed handoff."),
            hooksRun: [],
            infoHash: null
          };
        }

        try {
          await mkdir(downloadPath, { recursive: true });
          const addOptions: Parameters<TorrentDownloadClient["addTorrent"]>[0] = {
            torrentPath,
            downloadPath,
            skipHashCheck: true
          };
          if (context.torrentClientOptions.category) addOptions.category = context.torrentClientOptions.category;
          if (context.torrentClientOptions.tags?.length) addOptions.tags = context.torrentClientOptions.tags;
          const result = await context.torrentClient.addTorrent(addOptions);
          await context.log("info", "qBittorrent seed handoff queued.", {
            client: context.torrentClient.name,
            infoHash: result.infoHash,
            torrentPath,
            downloadPath,
            skipHashCheck: true
          });
          return {
            ...base("completed", "PTP upload torrent handed to qBittorrent for seeding."),
            hooksRun: ["qbittorrent-seed-handoff"],
            infoHash: result.infoHash
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            ...base("failed", message),
            hooksRun: [],
            infoHash: null
          };
        }
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

      await context.onPhaseStarted(handler.phase);
      await context.log("info", "Starting phase.", { phase: handler.phase });
      const output = await handler.run(context);
      await context.writeOutput(handler.phase, output);
      await context.onPhaseFinished(handler.phase, output);
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

  async runSelected(phases: UploadPhase[], context: PhaseContext): Promise<Partial<PhaseOutputMap>> {
    const selected = new Set(phases);

    for (const handler of this.handlers.filter((item) => selected.has(item.phase))) {
      if (await context.stopRequested()) {
        await context.log("info", "Stop requested before phase.", { phase: handler.phase });
        return context.snapshotOutputs();
      }

      await context.onPhaseStarted(handler.phase);
      await context.log("info", "Starting phase.", { phase: handler.phase });
      const output = await handler.run(context);
      await context.writeOutput(handler.phase, output);
      await context.onPhaseFinished(handler.phase, output);
      await context.log(output.status === "failed" ? "error" : output.status === "blocked" ? "warn" : "info", "Finished phase.", {
        phase: handler.phase,
        status: output.status,
        message: output.message
      });

      const reviewGateBlock = output.status === "blocked" && (handler.phase === "duplicate-check" || handler.phase === "preflight");
      if (output.status === "failed" || (output.status === "blocked" && !reviewGateBlock)) {
        return context.snapshotOutputs();
      }
    }

    return context.snapshotOutputs();
  }

  async runUploadTail(context: PhaseContext): Promise<Partial<PhaseOutputMap>> {
    return this.runFrom("upload", context);
  }

  async runPreparationToReview(context: PhaseContext): Promise<Partial<PhaseOutputMap>> {
    const reviewIndex = this.handlers.findIndex((handler) => handler.phase === "review");
    if (reviewIndex < 0) throw new Error("Missing phase handler: review");

    for (const handler of this.handlers.slice(0, reviewIndex + 1)) {
      if (await context.stopRequested()) {
        await context.log("info", "Stop requested before phase.", { phase: handler.phase });
        return context.snapshotOutputs();
      }

      await context.onPhaseStarted(handler.phase);
      await context.log("info", "Starting phase.", { phase: handler.phase });
      const output = await handler.run(context);
      await context.writeOutput(handler.phase, output);
      await context.onPhaseFinished(handler.phase, output);
      await context.log(output.status === "failed" ? "error" : output.status === "blocked" ? "warn" : "info", "Finished phase.", {
        phase: handler.phase,
        status: output.status,
        message: output.message
      });

      const reviewGateBlock = output.status === "blocked" && (handler.phase === "duplicate-check" || handler.phase === "preflight");
      if (output.status === "failed" || (output.status === "blocked" && !reviewGateBlock)) {
        return context.snapshotOutputs();
      }
    }

    return context.snapshotOutputs();
  }
}
