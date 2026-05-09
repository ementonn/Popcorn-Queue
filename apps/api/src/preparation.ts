import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildJobWorkspacePaths,
  buildReviewDraft,
  createJobManifest,
  computeUploadReadiness,
  missingPtpDraftFields,
  type DownloadStatus,
  type EvidenceRequirement,
  type ReviewDraft,
  type UploadPhase,
  type UploadReadiness
} from "@popcorn-queue/core";
import {
  PhaseRunner,
  createPhaseContext,
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
import type { Job, JobPhase, JobRepository, JobState, PhaseRun, PhaseState } from "./jobs.js";
import { appendJobEvent } from "./job-logs.js";

type MaybePromise<T> = T | Promise<T>;

export interface PreparationJobStore {
  get(id: string): MaybePromise<Job | null>;
  updateDownloadStatus(id: string, status: DownloadStatus): MaybePromise<Job | null>;
  markPreparedForReview(id: string, input: Parameters<JobRepository["markPreparedForReview"]>[1]): MaybePromise<Job | null>;
  markPreparationPhaseStarted(id: string, phase: JobPhase): MaybePromise<Job | null>;
  markPreparationPhaseFinished(id: string, input: Parameters<JobRepository["markPreparationPhaseFinished"]>[1]): MaybePromise<Job | null>;
  markPreparationResult(id: string, input: Parameters<JobRepository["markPreparationResult"]>[1]): MaybePromise<Job | null>;
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
        await this.options.jobs.updateDownloadStatus(job.id, status);
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

  private workerJobInput(job: Job, workingDirectory: string, downloadDirectory: string, outputDirectory: string) {
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
      ...(job.source.mediaPath ? { mediaPath: job.source.mediaPath } : {})
    };
  }

  private async collectArtifacts(job: Job, jobRoot: string, outputs: Partial<PhaseOutputMap>): Promise<Job["artifacts"]> {
    const artifacts: Job["artifacts"] = {};
    const preparedMedia = outputs["prepare-media"];
    if (preparedMedia?.outputPath) artifacts.mediaFiles = [relativeToJob(jobRoot, preparedMedia.outputPath)!];

    const imageHost = outputs["image-host-upload"];
    const hostedUrls = imageHost?.uploads.flatMap((attempt) => (attempt.result?.url ? [attempt.result.url] : [])) ?? [];
    if (hostedUrls.length) {
      artifacts.screenshots = hostedUrls;
    } else {
      const screenshotFiles = outputs.screenshots?.files
        .map((file) => relativeToJob(jobRoot, file))
        .filter((file): file is string => Boolean(file)) ?? [];
      if (screenshotFiles.length) artifacts.screenshots = screenshotFiles;
    }

    const mediaInspection = outputs["inspect-media"];
    const mediaInfoText = mediaInspection?.mediaInfoText?.result?.stdout ?? mediaInspection?.mediaInfo?.result?.stdout;
    const mediaInfoJson = mediaInspection?.mediaInfoJson?.result?.stdout;
    if (mediaInfoText) {
      artifacts.mediaInfoText = mediaInfoText;
      artifacts.mediainfo = mediaInfoText;
    }
    if (mediaInfoJson) artifacts.mediaInfoJson = mediaInfoJson;
    artifacts.releaseName = job.uploadPlan.releaseName.generated;
    if (job.checkResult?.decision.reason) artifacts.duplicateResult = job.checkResult.decision.reason;

    const torrentCreate = outputs["torrent-create"];
    const uploadTorrent = relativeToJob(jobRoot, torrentCreate?.uploadTorrentPath);
    if (uploadTorrent) artifacts.uploadTorrent = uploadTorrent;
    artifacts.qbReady = outputs["seed-prepare"]?.status === "completed";
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
