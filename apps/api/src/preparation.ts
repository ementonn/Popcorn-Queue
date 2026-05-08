import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  buildJobWorkspacePaths,
  computeUploadReadiness,
  type EvidenceRequirement,
  type UploadReadiness
} from "@popcorn-queue/core";
import {
  PhaseRunner,
  createPhaseContext,
  type CommandExecutor,
  type CommandInvocation,
  type CommandResult,
  type ImageHostUploader,
  type PhaseLogLevel,
  type WorkerTool
} from "@popcorn-queue/worker";
import type { Job, JobRepository } from "./jobs.js";
import { appendJobEvent } from "./job-logs.js";

type MaybePromise<T> = T | Promise<T>;

export interface PreparationJobStore {
  get(id: string): MaybePromise<Job | null>;
  markPreparedForReview(id: string, input: Parameters<JobRepository["markPreparedForReview"]>[1]): MaybePromise<Job | null>;
}

export interface PreparationServiceOptions {
  dataRoot: string;
  jobs: PreparationJobStore;
  runExternalTools: boolean;
  toolCommands: Partial<Record<WorkerTool, string>>;
  imageUploader?: ImageHostUploader;
}

function nowIso(): string {
  return new Date().toISOString();
}

function relativeToJob(jobRoot: string, filePath: string | null | undefined): string | undefined {
  if (!filePath) return undefined;
  return path.relative(jobRoot, filePath);
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

    const contextOptions: Parameters<typeof createPhaseContext>[2] = {
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
    const context = createPhaseContext(job.id, this.workerJobInput(job, paths.jobRoot, paths.screenshotsRawDir), contextOptions);

    const outputs = await new PhaseRunner().runPreparationToReview(context);
    const artifacts: Job["artifacts"] = {};
    const preparedMedia = outputs["prepare-media"];
    if (preparedMedia?.outputPath) artifacts.mediaFiles = [relativeToJob(paths.jobRoot, preparedMedia.outputPath)!];
    const imageHost = outputs["image-host-upload"];
    const hostedJson = relativeToJob(paths.jobRoot, imageHost?.hostedJsonPath);
    if (hostedJson) artifacts.screenshots = [hostedJson];
    const readiness = this.computeReadiness(job, artifacts);
    return this.options.jobs.markPreparedForReview(job.id, { uploadReadiness: readiness, artifacts });
  }

  private workerJobInput(job: Job, workingDirectory: string, outputDirectory: string) {
    const input = {
      candidate: job.candidate!,
      workingDirectory,
      outputDirectory
    };
    return {
      ...input,
      ...(job.checkResult ? { checkResult: job.checkResult } : {}),
      ...(job.torrent ? { torrent: job.torrent } : {})
    };
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
