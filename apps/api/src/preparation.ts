import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildJobWorkspacePaths,
  buildReviewDraft,
  buildScreenshotPlan,
  createJobManifest,
  computeUploadReadiness,
  detectMediaFeatures,
  missingPtpDraftFields,
  type DownloadStatus,
  type EvidenceRequirement,
  type ReviewDraft,
  type UploadPhase,
  type UploadReadiness
} from "@popcorn-queue/core";
import {
  MemoryPhaseOutputStore,
  PhaseRunner,
  createPhaseContext,
  parseMediaInfoSummary,
  type CommandExecutor,
  type CommandInvocation,
  type CommandResult,
  type CreatePhaseContextOptions,
  type ImageHostUploader,
  type PhaseOutputMap,
  type PhaseLogLevel,
  type TorrentDownloadClient,
  type WorkerTool
} from "@popcorn-queue/worker";
import { PHASE_RETRY_DEPENDENCIES, type Job, type JobPhase, type JobRepository, type JobState, type PhaseRun, type PhaseState } from "./jobs.js";
import { appendJobEvent } from "./job-logs.js";

type MaybePromise<T> = T | Promise<T>;

export interface PreparationJobStore {
  get(id: string): MaybePromise<Job | null>;
  updateDownloadStatus(id: string, status: DownloadStatus): MaybePromise<Job | null>;
  markPreparedForReview(id: string, input: Parameters<JobRepository["markPreparedForReview"]>[1]): MaybePromise<Job | null>;
  markPreparationPhaseStarted(id: string, phase: JobPhase): MaybePromise<Job | null>;
  markPreparationPhaseFinished(id: string, input: Parameters<JobRepository["markPreparationPhaseFinished"]>[1]): MaybePromise<Job | null>;
  markPreparationResult(id: string, input: Parameters<JobRepository["markPreparationResult"]>[1]): MaybePromise<Job | null>;
  retryCompletedPhase(id: string, phase: JobPhase): MaybePromise<Job | null>;
}

export interface PreparationServiceOptions {
  dataRoot: string;
  jobs: PreparationJobStore;
  runExternalTools: boolean;
  toolCommands: Partial<Record<WorkerTool, string>>;
  imageUploader?: ImageHostUploader;
  ptpAnnounceUrl?: string;
  torrentClient?: TorrentDownloadClient;
  torrentClientOptions?: {
    category?: string;
    tags?: string[];
    waitTimeoutMs?: number;
    waitIntervalMs?: number;
  };
  commandExecutor?: CommandExecutor;
}

export interface PreparationReviewStatus {
  readiness: UploadReadiness;
  blockers: string[];
  warnings: string[];
  evidence: EvidenceRequirement[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function relativeToJob(jobRoot: string, filePath: string | null | undefined): string | undefined {
  if (!filePath) return undefined;
  return path.relative(jobRoot, filePath);
}

function phaseStateFromStatus(status: PhaseOutputMap[UploadPhase]["status"]): PhaseState {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "warning";
}

function outputStatus(output: PhaseOutputMap[UploadPhase] | undefined): PhaseOutputMap[UploadPhase]["status"] | undefined {
  return output?.status;
}

interface DownloadLogState {
  lastState: string | null;
  lastBucket: number | null;
  completed: boolean;
  errored: boolean;
}

function clampedProgress(status: DownloadStatus): number | null {
  if (typeof status.progress !== "number" || !Number.isFinite(status.progress)) return null;
  return Math.max(0, Math.min(1, status.progress));
}

function progressBucket(status: DownloadStatus): number | null {
  const progress = clampedProgress(status);
  if (progress === null) return null;
  return Math.floor(progress * 20);
}

function percentLabel(status: DownloadStatus): string {
  const progress = clampedProgress(status);
  return progress === null ? "unknown" : `${Math.round(progress * 100)}%`;
}

function titleCaseState(state: string): string {
  return state
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function shouldLogDownloadStatus(status: DownloadStatus, state: DownloadLogState): boolean {
  if (status.error && !state.errored) return true;
  const progress = clampedProgress(status);
  if (progress === 1 && !state.completed) return true;
  const bucket = progressBucket(status);
  if (bucket !== null && bucket !== state.lastBucket) return true;
  return status.state !== state.lastState && bucket === null;
}

function downloadLogMessage(status: DownloadStatus): string {
  if (status.error) return `Download error: ${status.error}`;
  if (clampedProgress(status) === 1) return "Download complete.";
  if (status.progress !== null) return `Download progress: ${percentLabel(status)}.`;
  return `Download status: ${titleCaseState(status.state)}.`;
}

function downloadLogPayload(status: DownloadStatus) {
  return {
    client: status.client,
    infoHash: status.infoHash,
    state: status.state,
    progress: status.progress,
    downloaded: status.downloaded,
    size: status.size,
    amountLeft: status.amountLeft,
    downloadSpeed: status.downloadSpeed,
    uploadSpeed: status.uploadSpeed,
    eta: status.eta,
    seeds: status.seeds,
    peers: status.peers,
    error: status.error
  };
}

function updateDownloadLogState(state: DownloadLogState, status: DownloadStatus): void {
  state.lastState = status.state;
  state.lastBucket = progressBucket(status);
  if (clampedProgress(status) === 1) state.completed = true;
  if (status.error) state.errored = true;
}

function hasOutput<K extends UploadPhase>(outputs: Partial<PhaseOutputMap>, phase: K): outputs is Partial<PhaseOutputMap> & Pick<PhaseOutputMap, K> {
  return outputs[phase] !== undefined;
}

const disabledCommandExecutor: CommandExecutor = async (invocation: CommandInvocation): Promise<CommandResult> => ({
  command: invocation.command,
  args: invocation.args,
  exitCode: 1,
  signal: null,
  stdout: "",
  stderr: "",
  durationMs: 0,
  error: {
    message: "External tool execution is disabled."
  }
});

function resolveJobArtifact(jobRoot: string, artifact: string | null | undefined): string | undefined {
  if (!artifact) return undefined;
  if (/^https?:\/\//i.test(artifact)) return artifact;
  return path.isAbsolute(artifact) ? artifact : path.join(jobRoot, artifact);
}

function storedCommandResult(invocation: CommandInvocation, stdout: string): CommandResult {
  return {
    command: invocation.command,
    args: invocation.args,
    exitCode: 0,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 0
  };
}

function storedTool(tool: WorkerTool) {
  return {
    tool,
    command: "stored",
    available: true,
    version: null,
    location: null,
    error: null
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PreparationService {
  constructor(private readonly options: PreparationServiceOptions) {}

  enqueue(jobId: string): void {
    void this.runJob(jobId).catch(async (error: unknown) => {
      const paths = buildJobWorkspacePaths(this.options.dataRoot, jobId);
      await appendJobEvent(paths.logs.jobLog, {
        at: nowIso(),
        level: "error",
        message: "Preparation failed.",
        payload: { error: error instanceof Error ? error.message : String(error) }
      });
    });
  }

  async runJob(jobId: string): Promise<Job | null> {
    const job = await this.options.jobs.get(jobId);
    if (!job?.candidate) return job;

    const paths = buildJobWorkspacePaths(this.options.dataRoot, job.id);
    await Promise.all([
      mkdir(paths.inputDir, { recursive: true }),
      mkdir(paths.mediaUploadDir, { recursive: true }),
      mkdir(paths.mediaIntermediatesDir, { recursive: true }),
      mkdir(paths.screenshotsRawDir, { recursive: true }),
      mkdir(paths.screenshotsOptimizedDir, { recursive: true }),
      mkdir(paths.torrentDir, { recursive: true }),
      mkdir(paths.metadataDir, { recursive: true }),
      mkdir(paths.logs.dir, { recursive: true })
    ]);

    const downloadLogState: DownloadLogState = {
      lastState: null,
      lastBucket: null,
      completed: false,
      errored: false
    };

    const contextOptions: CreatePhaseContextOptions = {
      runExternalTools: this.options.runExternalTools,
      toolCommands: this.options.toolCommands,
      log: async (level: PhaseLogLevel, message: string, payload?: unknown) => {
        await appendJobEvent(paths.logs.jobLog, {
          at: nowIso(),
          level,
          message,
          payload
        });
      },
      reportDownloadStatus: async (status) => {
        try {
          await this.options.jobs.updateDownloadStatus(job.id, status);
        } catch (error) {
          await appendJobEvent(paths.logs.jobLog, {
            at: nowIso(),
            level: "warn",
            message: "Download status persistence failed.",
            payload: {
              error: errorMessage(error),
              client: status.client,
              infoHash: status.infoHash,
              state: status.state,
              progress: status.progress
            }
          });
        }
        if (shouldLogDownloadStatus(status, downloadLogState)) {
          await appendJobEvent(paths.logs.jobLog, {
            at: nowIso(),
            level: status.error ? "error" : "info",
            message: downloadLogMessage(status),
            payload: downloadLogPayload(status)
          });
        }
        updateDownloadLogState(downloadLogState, status);
      },
      onPhaseStarted: async (phase) => {
        await this.options.jobs.markPreparationPhaseStarted(job.id, phase as JobPhase);
      },
      onPhaseFinished: async (phase, output) => {
        await this.options.jobs.markPreparationPhaseFinished(job.id, {
          phase: phase as JobPhase,
          state: phaseStateFromStatus(output.status),
          message: output.message
        });
      }
    };
    if (this.options.commandExecutor) contextOptions.commandExecutor = this.options.commandExecutor;
    else if (!this.options.runExternalTools) contextOptions.commandExecutor = disabledCommandExecutor;
    if (this.options.imageUploader) contextOptions.imageUploader = this.options.imageUploader;
    if (this.options.ptpAnnounceUrl) contextOptions.ptpAnnounceUrl = this.options.ptpAnnounceUrl;
    if (this.options.torrentClient) contextOptions.torrentClient = this.options.torrentClient;
    if (this.options.torrentClientOptions) contextOptions.torrentClientOptions = this.options.torrentClientOptions;
    const context = createPhaseContext(job.id, this.workerJobInput(job, paths.jobRoot, paths.sourceDownloadDir, paths.screenshotsRawDir), contextOptions);

    const outputs = await new PhaseRunner().runPreparationToReview(context);
    const artifacts = await this.collectArtifacts(job, paths.jobRoot, outputs);
    const phaseRuns = this.mergePhaseRuns(job, outputs);
    const stoppedPhase = this.stoppedPhase(outputs);
    const reachedReview = Boolean(outputs.review);
    const preparedMedia = outputs["prepare-media"];
    const reviewStatus = computePreparationReviewStatus(job, artifacts);
    artifacts.reviewBlockers = reviewStatus.blockers;
    artifacts.reviewWarnings = reviewStatus.warnings;
    const readiness = reviewStatus.readiness;
    const failed = stoppedPhase ? outputStatus(outputs[stoppedPhase]) === "failed" : false;
    const state: JobState = failed ? "failed" : reachedReview ? "review" : "preparing";
    const phase = (reachedReview ? "review" : stoppedPhase ?? job.phase) as JobPhase;
    const uploadReadiness: UploadReadiness = reachedReview ? readiness : "missing_evidence";
    const eventLevel = failed ? "error" : reachedReview && readiness === "ready" ? "info" : reachedReview ? "warn" : "info";
    const eventMessage = reachedReview ? "Upload package ready for review." : preparedMedia?.outputPath ? "Preparation paused before review." : "Preparation waiting for required evidence.";
    const humanStep = reachedReview ? "Review upload package" : failed ? "Preparation failed" : "Preparing upload package";

    await this.writeManifest(job, paths.jobRoot, state, artifacts);
    return this.options.jobs.markPreparationResult(job.id, {
      state,
      phase,
      uploadReadiness,
      humanStep,
      artifacts,
      phases: phaseRuns,
      eventLevel,
      eventMessage,
      workspace: {
        dataRoot: paths.dataRoot,
        jobRoot: paths.jobRoot,
        manifest: paths.manifest
      }
    });
  }

  async retryCompletedPhase(jobId: string, phase: JobPhase): Promise<Job | null> {
    const queued = await this.options.jobs.retryCompletedPhase(jobId, phase);
    if (!queued?.candidate || queued.state !== "preparing") return queued;

    const paths = buildJobWorkspacePaths(this.options.dataRoot, queued.id);
    await Promise.all([
      mkdir(paths.inputDir, { recursive: true }),
      mkdir(paths.mediaUploadDir, { recursive: true }),
      mkdir(paths.mediaIntermediatesDir, { recursive: true }),
      mkdir(paths.screenshotsRawDir, { recursive: true }),
      mkdir(paths.screenshotsOptimizedDir, { recursive: true }),
      mkdir(paths.torrentDir, { recursive: true }),
      mkdir(paths.metadataDir, { recursive: true }),
      mkdir(paths.logs.dir, { recursive: true })
    ]);

    const phasesToRun = PHASE_RETRY_DEPENDENCIES[phase] ?? [phase];
    const contextOptions: CreatePhaseContextOptions = {
      outputStore: new MemoryPhaseOutputStore(this.seedOutputsFromJob(queued, paths.jobRoot)),
      runExternalTools: this.options.runExternalTools,
      toolCommands: this.options.toolCommands,
      log: async (level: PhaseLogLevel, message: string, payload?: unknown) => {
        await appendJobEvent(paths.logs.jobLog, {
          at: nowIso(),
          level,
          message,
          payload
        });
      },
      onPhaseStarted: async (runningPhase) => {
        await this.options.jobs.markPreparationPhaseStarted(queued.id, runningPhase as JobPhase);
      },
      onPhaseFinished: async (runningPhase, output) => {
        await this.options.jobs.markPreparationPhaseFinished(queued.id, {
          phase: runningPhase as JobPhase,
          state: phaseStateFromStatus(output.status),
          message: output.message
        });
      }
    };
    if (this.options.commandExecutor) contextOptions.commandExecutor = this.options.commandExecutor;
    else if (!this.options.runExternalTools) contextOptions.commandExecutor = disabledCommandExecutor;
    if (this.options.imageUploader) contextOptions.imageUploader = this.options.imageUploader;
    if (this.options.ptpAnnounceUrl) contextOptions.ptpAnnounceUrl = this.options.ptpAnnounceUrl;
    if (this.options.torrentClient) contextOptions.torrentClient = this.options.torrentClient;
    if (this.options.torrentClientOptions) contextOptions.torrentClientOptions = this.options.torrentClientOptions;

    const context = createPhaseContext(queued.id, this.workerJobInput(queued, paths.jobRoot, paths.sourceDownloadDir, paths.screenshotsRawDir), contextOptions);
    const allOutputs = await new PhaseRunner().runSelected(phasesToRun, context);
    const executedOutputs = this.pickOutputs(allOutputs, phasesToRun);
    const refreshedArtifacts = await this.collectArtifacts(queued, paths.jobRoot, allOutputs);
    const artifacts = { ...queued.artifacts, ...refreshedArtifacts };
    const phaseRuns = this.mergePhaseRuns(queued, executedOutputs);
    const stoppedPhase = this.stoppedPhase(executedOutputs);
    const reachedReview = Boolean(executedOutputs.review);
    const reviewStatus = computePreparationReviewStatus(queued, artifacts);
    artifacts.reviewBlockers = reviewStatus.blockers;
    artifacts.reviewWarnings = reviewStatus.warnings;
    const failed = stoppedPhase ? outputStatus(executedOutputs[stoppedPhase]) === "failed" : false;
    const state: JobState = failed ? "failed" : reachedReview ? "review" : "preparing";
    const finalPhase = (reachedReview ? "review" : stoppedPhase ?? phase) as JobPhase;
    const uploadReadiness: UploadReadiness = reachedReview ? reviewStatus.readiness : "missing_evidence";
    const eventLevel = failed ? "error" : reachedReview && uploadReadiness === "ready" ? "info" : reachedReview ? "warn" : "info";
    const eventMessage = failed ? "Phase retry failed." : reachedReview ? "Phase retry ready for review." : "Phase retry queued.";
    const humanStep = reachedReview ? "Review upload package" : failed ? "Preparation failed" : "Preparing upload package";

    await this.writeManifest(queued, paths.jobRoot, state, artifacts);
    return this.options.jobs.markPreparationResult(queued.id, {
      state,
      phase: finalPhase,
      uploadReadiness,
      humanStep,
      artifacts,
      phases: phaseRuns,
      eventLevel,
      eventMessage,
      workspace: {
        dataRoot: paths.dataRoot,
        jobRoot: paths.jobRoot,
        manifest: paths.manifest
      }
    });
  }

  private workerJobInput(job: Job, workingDirectory: string, downloadDirectory: string, outputDirectory: string) {
    const artifactMediaPath = resolveJobArtifact(workingDirectory, job.artifacts.mediaFiles?.[0]);
    const input = {
      candidate: job.candidate!,
      workingDirectory,
      downloadDirectory,
      outputDirectory
    };
    return {
      ...input,
      ...(job.checkResult ? { checkResult: job.checkResult } : {}),
      ...(job.torrent ? { torrent: job.torrent } : {}),
      ...(job.torrent?.filePath ? { sourceTorrentPath: job.torrent.filePath } : {}),
      ...(job.reviewDraft ? { reviewDraft: job.reviewDraft } : {}),
      ...(job.source.mediaPath ? { mediaPath: job.source.mediaPath } : artifactMediaPath && !/^https?:\/\//i.test(artifactMediaPath) ? { mediaPath: artifactMediaPath } : {})
    };
  }

  private pickOutputs(outputs: Partial<PhaseOutputMap>, phases: UploadPhase[]): Partial<PhaseOutputMap> {
    const picked: Partial<PhaseOutputMap> = {};
    for (const phase of phases) {
      const output = outputs[phase];
      if (output) (picked as Record<UploadPhase, PhaseOutputMap[UploadPhase]>)[phase] = output;
    }
    return picked;
  }

  private seedOutputsFromJob(job: Job, jobRoot: string): Partial<PhaseOutputMap> {
    const producedAt = nowIso();
    const outputs: Partial<PhaseOutputMap> = {};
    const mediaPath = resolveJobArtifact(jobRoot, job.artifacts.mediaFiles?.[0]);
    if (mediaPath && !/^https?:\/\//i.test(mediaPath)) {
      outputs["prepare-media"] = {
        status: "completed",
        message: "Stored prepared media artifact reused.",
        producedAt,
        inputPath: job.source.mediaPath ?? mediaPath,
        outputPath: mediaPath,
        mode: "skipped",
        remuxed: false
      };
    }

    if (job.checkResult) {
      outputs["duplicate-check"] = {
        status: "completed",
        message: "Stored duplicate check reused.",
        producedAt,
        decision: job.checkResult.decision,
        reviewGates: job.uploadPlan.reviewGates
      };
    }

    const textInvocation: CommandInvocation = { command: "stored", args: ["mediainfo.txt"] };
    const jsonInvocation: CommandInvocation = { command: "stored", args: ["mediainfo.json"] };
    const mediaInfoText = job.artifacts.mediaInfoText ?? job.artifacts.mediainfo ?? "";
    const mediaInfoJson = job.artifacts.mediaInfoJson ?? "";
    if (mediaInfoText || mediaInfoJson || job.artifacts.mediaFeatureSuggestions) {
      outputs["inspect-media"] = {
        status: "completed",
        message: "Stored MediaInfo artifact reused.",
        producedAt,
        mediaPath: mediaPath ?? null,
        inspectionPlan: job.uploadPlan.media,
        tools: {
          ffmpeg: storedTool("ffmpeg"),
          mediainfo: storedTool("mediainfo"),
          mkvmerge: storedTool("mkvmerge"),
          mpv: storedTool("mpv"),
          oxipng: storedTool("oxipng"),
          "xvfb-run": storedTool("xvfb-run")
        },
        mediaInfo: mediaInfoText
          ? { invocation: textInvocation, result: storedCommandResult(textInvocation, mediaInfoText) }
          : { invocation: textInvocation, skippedReason: "No stored MediaInfo text is available." },
        mediaInfoText: mediaInfoText
          ? { invocation: textInvocation, result: storedCommandResult(textInvocation, mediaInfoText) }
          : { invocation: textInvocation, skippedReason: "No stored MediaInfo text is available." },
        mediaInfoJson: mediaInfoJson
          ? { invocation: jsonInvocation, result: storedCommandResult(jsonInvocation, mediaInfoJson) }
          : { invocation: jsonInvocation, skippedReason: "No stored MediaInfo JSON is available." },
        summary: mediaInfoJson ? parseMediaInfoSummary(mediaInfoJson) : null,
        features: mediaInfoJson
          ? detectMediaFeatures({ mediaInfoJson, releaseName: job.artifacts.releaseName ?? job.uploadPlan.releaseName.generated })
          : { hdrFormats: [], editionFeatures: job.artifacts.mediaFeatureSuggestions ?? [] }
      };
    }

    const screenshots = job.artifacts.screenshots ?? [];
    if (screenshots.length) {
      const uploads = screenshots.map((screenshot, index) => {
        const mediumUrl = job.artifacts.screenshotPreviews?.[index] ?? null;
        const filePath = resolveJobArtifact(jobRoot, screenshot) ?? screenshot;
        if (/^https?:\/\//i.test(screenshot)) {
          return {
            filePath,
            host: "stored",
            result: {
              host: "stored",
              url: screenshot,
              viewerUrl: screenshot,
              deleteUrl: null,
              mediumUrl,
              width: null,
              height: null
            }
          };
        }
        return {
          filePath,
          host: null,
          skippedReason: "Stored local screenshot is pending image host upload."
        };
      });
      outputs.screenshots = {
        status: "completed",
        message: "Stored screenshots reused.",
        producedAt,
        mediaPath: mediaPath ?? null,
        outputDirectory: path.join(jobRoot, "screenshots", "raw"),
        plan: buildScreenshotPlan(job.uploadPlan.parsed, undefined, { rng: () => 0.5 }),
        tools: {
          ffmpeg: storedTool("ffmpeg"),
          mpv: storedTool("mpv"),
          oxipng: storedTool("oxipng"),
          "xvfb-run": storedTool("xvfb-run")
        },
        requiredTools: ["ffmpeg", "oxipng"],
        ffmpeg: [],
        optimizer: [],
        uploads,
        files: screenshots.map((screenshot) => resolveJobArtifact(jobRoot, screenshot) ?? screenshot)
      };
      outputs["image-host-upload"] = {
        status: "completed",
        message: "Stored screenshot uploads reused.",
        producedAt,
        files: outputs.screenshots.files,
        hostedJsonPath: null,
        uploads
      };
    }

    const uploadTorrentPath = resolveJobArtifact(jobRoot, job.artifacts.uploadTorrent);
    if (uploadTorrentPath) {
      outputs["torrent-create"] = {
        status: "completed",
        message: "Stored upload torrent reused.",
        producedAt,
        reusePlan: job.uploadPlan.torrentReuse,
        sourceTorrentPath: job.torrent?.filePath ?? null,
        uploadTorrentPath
      };
    }

    return outputs;
  }

  private async collectArtifacts(job: Job, jobRoot: string, outputs: Partial<PhaseOutputMap>): Promise<Job["artifacts"]> {
    const artifacts: Job["artifacts"] = {};
    const preparedMedia = outputs["prepare-media"];
    if (preparedMedia?.outputPath) artifacts.mediaFiles = [relativeToJob(jobRoot, preparedMedia.outputPath)!];

    const imageHost = outputs["image-host-upload"];
    const hostedUrls = imageHost?.uploads.flatMap((attempt) => (attempt.result?.url ? [attempt.result.url] : [])) ?? [];
    const hostedPreviews = imageHost?.uploads.flatMap((attempt) => (attempt.result?.url ? [attempt.result.mediumUrl ?? attempt.result.url] : [])) ?? [];
    if (hostedUrls.length) {
      artifacts.screenshots = hostedUrls;
      artifacts.screenshotPreviews = hostedPreviews;
    }

    const mediaInspection = outputs["inspect-media"];
    const mediaInfoText = mediaInspection?.mediaInfoText?.result?.stdout ?? mediaInspection?.mediaInfo?.result?.stdout;
    const mediaInfoJson = mediaInspection?.mediaInfoJson?.result?.stdout;
    if (mediaInfoText) {
      artifacts.mediaInfoText = mediaInfoText;
      artifacts.mediainfo = mediaInfoText;
    }
    if (mediaInfoJson) artifacts.mediaInfoJson = mediaInfoJson;
    if (mediaInspection) artifacts.mediaFeatureSuggestions = mediaInspection.features.editionFeatures;
    artifacts.releaseName = job.uploadPlan.releaseName.generated;
    if (job.checkResult?.decision.reason) artifacts.duplicateResult = job.checkResult.decision.reason;

    const torrentCreate = outputs["torrent-create"];
    const uploadTorrent = relativeToJob(jobRoot, torrentCreate?.uploadTorrentPath);
    if (uploadTorrent) artifacts.uploadTorrent = uploadTorrent;
    const download = outputs["download-or-locate"];
    if (download?.infoHash) artifacts.qbDownloadInfoHash = download.infoHash;
    if (outputs["seed-prepare"]) artifacts.qbReady = outputs["seed-prepare"]?.status === "completed";
    if (outputs.preflight?.uploadDraft.description) artifacts.description = outputs.preflight.uploadDraft.description;
    return artifacts;
  }

  private mergePhaseRuns(job: Job, outputs: Partial<PhaseOutputMap>): PhaseRun[] {
    return job.phases.map((run) => {
      const output = outputs[run.phase];
      if (!output) return run;
      const next: PhaseRun = {
        ...run,
        state: phaseStateFromStatus(output.status),
        message: output.message,
        finishedAt: output.producedAt
      };
      if (!next.startedAt) next.startedAt = output.producedAt;
      return next;
    });
  }

  private stoppedPhase(outputs: Partial<PhaseOutputMap>): UploadPhase | null {
    for (const phase of Object.keys(outputs) as UploadPhase[]) {
      const output = outputs[phase];
      if (output?.status === "blocked" || output?.status === "failed") return phase;
    }
    return null;
  }

  private async writeManifest(job: Job, jobRoot: string, state: string, artifacts: Job["artifacts"]): Promise<void> {
    const paths = buildJobWorkspacePaths(this.options.dataRoot, job.id);
    const manifest = createJobManifest({
      jobId: job.id,
      createdAt: job.createdAt,
      state,
      source: job.source,
      paths,
      uploadFiles: artifacts.mediaFiles ?? [],
      torrentFile: artifacts.uploadTorrent ?? null,
      sourceRef: {
        sourceId: job.id,
        originalDownloadPresent: false
      }
    });
    await writeFile(path.join(jobRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

}

function hostedPngCount(screenshots: string[] | undefined): number {
  return (screenshots ?? []).filter((url) => /^https?:\/\//i.test(url) && /\.png(?:[?#]|$)/i.test(url)).length;
}

function reviewDraftForStatus(job: Pick<Job, "candidate" | "uploadPlan" | "artifacts" | "checkResult" | "reviewDraft">, artifacts: Job["artifacts"]): ReviewDraft | undefined {
  if (!job.candidate) return job.reviewDraft;
  const draftArtifacts: Parameters<typeof buildReviewDraft>[0]["artifacts"] = {};
  if (artifacts.releaseName !== undefined) draftArtifacts.releaseName = artifacts.releaseName;
  if (artifacts.description !== undefined) draftArtifacts.description = artifacts.description;
  if (artifacts.mediaInfoText !== undefined) draftArtifacts.mediainfo = artifacts.mediaInfoText;
  else if (artifacts.mediainfo !== undefined) draftArtifacts.mediainfo = artifacts.mediainfo;
  if (artifacts.mediaFeatureSuggestions !== undefined) draftArtifacts.mediaFeatureSuggestions = artifacts.mediaFeatureSuggestions;
  const input: Parameters<typeof buildReviewDraft>[0] = {
    candidate: job.candidate,
    uploadPlan: job.uploadPlan,
    artifacts: draftArtifacts
  };
  if (job.checkResult) input.checkResult = job.checkResult;
  const generated = buildReviewDraft(input);
  if (!job.reviewDraft) return generated;
  return {
    ...generated,
    ...job.reviewDraft,
    releaseName: job.reviewDraft.releaseName || generated.releaseName,
    description: job.reviewDraft.description || generated.description,
    groupId: job.reviewDraft.groupId ?? generated.groupId,
    type: job.reviewDraft.type || generated.type,
    codec: job.reviewDraft.codec || generated.codec,
    container: job.reviewDraft.container || generated.container,
    resolution: job.reviewDraft.resolution || generated.resolution,
    source: job.reviewDraft.source || generated.source,
    imdb: job.reviewDraft.imdb || generated.imdb || "",
    title: job.reviewDraft.title || generated.title || "",
    year: job.reviewDraft.year || generated.year || "",
    subtitles: job.reviewDraft.subtitles.length ? job.reviewDraft.subtitles : generated.subtitles,
    trumpable: job.reviewDraft.trumpable.length ? job.reviewDraft.trumpable : generated.trumpable,
    artists: job.reviewDraft.artists?.length ? job.reviewDraft.artists : generated.artists ?? []
  };
}

export function computePreparationReviewStatus(job: Pick<Job, "candidate" | "uploadPlan" | "artifacts" | "checkResult" | "reviewDraft">, artifacts: Job["artifacts"]): PreparationReviewStatus {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const hasMedia = Boolean(artifacts.mediaFiles?.length);
  const hasTextInfo = Boolean(artifacts.mediaInfoText || artifacts.mediainfo || artifacts.bdinfo);
  const hasHostedScreenshots = hostedPngCount(artifacts.screenshots) >= 3;
  const hasUploadTorrent = Boolean(artifacts.uploadTorrent);
  const draft = reviewDraftForStatus(job, artifacts);
  const missingDraftFields = draft ? missingPtpDraftFields(draft) : ["reviewDraft"];

  if (!hasMedia) blockers.push("Missing media file");
  if (!hasTextInfo) blockers.push("Missing text MediaInfo or BDInfo");
  if (!hasHostedScreenshots) blockers.push("Missing screenshot evidence");
  if (!hasUploadTorrent) blockers.push("Missing upload torrent");
  for (const field of missingDraftFields) blockers.push(`Missing draft field: ${field}`);

  for (const gate of job.uploadPlan.reviewGates) {
    if (gate.status === "open" && gate.severity === "blocker") blockers.push(`Review gate: ${gate.title}`);
  }

  if ((artifacts.mediaInfoText || artifacts.mediainfo) && !artifacts.mediaInfoJson) warnings.push("Missing JSON MediaInfo for internal parsing");

  const evidence: EvidenceRequirement[] = [
    {
      id: "media",
      label: "Upload media",
      present: hasMedia,
      blocksUpload: true,
      detail: "Final upload media is missing."
    },
    {
      id: "text-mediainfo",
      label: "Text MediaInfo or BDInfo",
      present: hasTextInfo,
      blocksUpload: true,
      detail: "Full text MediaInfo or BDInfo is missing."
    },
    {
      id: "screenshots",
      label: "Hosted PNG screenshots",
      present: hasHostedScreenshots,
      blocksUpload: true,
      detail: "At least three hosted PNG screenshots are required."
    },
    {
      id: "upload-torrent",
      label: "Upload torrent",
      present: hasUploadTorrent,
      blocksUpload: true,
      detail: "Upload torrent is missing."
    },
    {
      id: "review-draft",
      label: "PTP draft fields",
      present: missingDraftFields.length === 0,
      blocksUpload: true,
      detail: "Required PTP draft fields are missing."
    }
  ];

  return {
    readiness: computeUploadReadiness(job.uploadPlan.reviewGates, evidence),
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    evidence
  };
}
