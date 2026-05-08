import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildJobWorkspacePaths,
  createJobManifest,
  computeUploadReadiness,
  type EvidenceRequirement,
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
  markPreparedForReview(id: string, input: Parameters<JobRepository["markPreparedForReview"]>[1]): MaybePromise<Job | null>;
  markPreparationResult(id: string, input: Parameters<JobRepository["markPreparationResult"]>[1]): MaybePromise<Job | null>;
}

export interface PreparationServiceOptions {
  dataRoot: string;
  jobs: PreparationJobStore;
  runExternalTools: boolean;
  toolCommands: Partial<Record<WorkerTool, string>>;
  imageUploader?: ImageHostUploader;
  torrentClient?: TorrentDownloadClient;
  torrentClientOptions?: {
    category?: string;
    tags?: string[];
    waitTimeoutMs?: number;
    waitIntervalMs?: number;
  };
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
      }
    };
    if (!this.options.runExternalTools) contextOptions.commandExecutor = disabledCommandExecutor;
    if (this.options.imageUploader) contextOptions.imageUploader = this.options.imageUploader;
    if (this.options.torrentClient) contextOptions.torrentClient = this.options.torrentClient;
    if (this.options.torrentClientOptions) contextOptions.torrentClientOptions = this.options.torrentClientOptions;
    const context = createPhaseContext(job.id, this.workerJobInput(job, paths.jobRoot, paths.sourceDownloadDir, paths.screenshotsRawDir), contextOptions);

    const outputs = await new PhaseRunner().runPreparationToReview(context);
    const artifacts = await this.collectArtifacts(job, paths.jobRoot, outputs);
    const phaseRuns = this.mergePhaseRuns(job, outputs);
    const stoppedPhase = this.stoppedPhase(outputs);
    const reachedReview = Boolean(outputs.review);
    const preparedMedia = outputs["prepare-media"];
    const readiness = this.computeReadiness(job, artifacts);
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
      ...(job.torrent?.filePath ? { sourceTorrentPath: job.torrent.filePath } : {})
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

    const mediaInfo = outputs["inspect-media"]?.mediaInfo.result?.stdout;
    if (mediaInfo) artifacts.mediainfo = mediaInfo;
    artifacts.releaseName = job.uploadPlan.releaseName.generated;
    if (job.checkResult?.decision.reason) artifacts.duplicateResult = job.checkResult.decision.reason;

    const torrentCreate = outputs["torrent-create"];
    const uploadTorrent = relativeToJob(jobRoot, torrentCreate?.uploadTorrentPath);
    if (uploadTorrent) artifacts.uploadTorrent = uploadTorrent;
    artifacts.qbReady = outputs["seed-prepare"]?.status === "completed";
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

  private computeReadiness(job: Job, artifacts: Job["artifacts"]): UploadReadiness {
    const evidence: EvidenceRequirement[] = [
      {
        id: "media",
        label: "Upload media",
        present: Boolean(artifacts.mediaFiles?.length),
        blocksUpload: true,
        detail: "Final upload media is missing."
      }
    ];
    return computeUploadReadiness(job.uploadPlan.reviewGates, evidence);
  }
}
