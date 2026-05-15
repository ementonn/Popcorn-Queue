import { mkdir } from "node:fs/promises";
import path from "node:path";
import { buildJobWorkspacePaths, type CacheStore, type NormalizedPtpResponse, type UploadPhase } from "@popcorn-queue/core";
import {
  PhaseRunner,
  createPhaseContext,
  type CreatePhaseContextOptions,
  type PhaseLogLevel,
  type PhaseOutputMap,
  type PtpSubmitter,
  type TorrentDownloadClient
} from "@popcorn-queue/worker";
import type { ApiConfig } from "../config.js";
import { appendJobEvent } from "../job-logs.js";
import type { Job, PhaseRun, PhaseState } from "../jobs.js";
import type { PrismaPersistence } from "../persistence.js";
import type { PreparationService } from "../preparation.js";
import { createPtpCacheSyncer } from "./ptp-cache-sync.js";

export interface JobActionContext {
  config(): ApiConfig;
  jobs: PrismaPersistence["jobs"];
  cache: CacheStore<NormalizedPtpResponse>;
  getTorrentClient(): TorrentDownloadClient | null;
  getPtpSubmitter(): PtpSubmitter | undefined;
  getPreparation(): PreparationService;
  enqueuePreparation(jobId: string): void;
}

function phaseStateFromStatus(status: PhaseOutputMap[UploadPhase]["status"]): PhaseState {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "warning";
}

function mergePhaseRuns(job: Job, outputs: Partial<PhaseOutputMap>): PhaseRun[] {
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

function jobLogPath(config: ApiConfig, job: Job): string {
  return job.workspace?.jobRoot ? path.join(job.workspace.jobRoot, "logs", "job.log") : buildJobWorkspacePaths(config.paths.dataRoot, job.id).logs.jobLog;
}

export async function startUploadJob(context: JobActionContext, id: string): Promise<Job | null> {
  const config = context.config();
  const started = await context.jobs.startUpload(id);
  if (!started || started.state !== "uploading") return started;
  if (!started.candidate) {
    return context.jobs.markUploadFailed(id, "Cannot upload a job without candidate metadata.");
  }

  const fallbackPaths = buildJobWorkspacePaths(config.paths.dataRoot, id);
  const jobRoot = started.workspace?.jobRoot ?? fallbackPaths.jobRoot;
  const logPath = jobLogPath(config, started);
  const mediaArtifact = started.artifacts.mediaFiles?.[0];
  const mediaPath = mediaArtifact ? (path.isAbsolute(mediaArtifact) ? mediaArtifact : path.join(jobRoot, mediaArtifact)) : undefined;
  await mkdir(path.dirname(logPath), { recursive: true });
  const contextOptions: CreatePhaseContextOptions = {
    log: async (level: PhaseLogLevel, message: string, payload?: unknown) => {
      await appendJobEvent(logPath, {
        at: new Date().toISOString(),
        level,
        message,
        payload
      });
    }
  };
  const ptpSubmitter = context.getPtpSubmitter();
  const torrentClient = context.getTorrentClient();
  if (ptpSubmitter) contextOptions.ptpSubmitter = ptpSubmitter;
  contextOptions.ptpCacheSyncer = createPtpCacheSyncer(context.cache);
  if (config.ptp.announceUrl) contextOptions.ptpAnnounceUrl = config.ptp.announceUrl;
  if (torrentClient) {
    contextOptions.torrentClient = torrentClient;
    contextOptions.torrentClientOptions = {
      ...(config.integrations.qbittorrentCategory ? { category: config.integrations.qbittorrentCategory } : {}),
      ...(config.integrations.qbittorrentTags.length ? { tags: config.integrations.qbittorrentTags } : {}),
      waitTimeoutMs: config.integrations.qbittorrentDownloadWaitMs,
      waitIntervalMs: config.integrations.qbittorrentDownloadPollMs
    };
  }
  const phaseContext = createPhaseContext(
    id,
    {
      candidate: started.candidate,
      ...(started.checkResult ? { checkResult: started.checkResult } : {}),
      ...(started.torrent ? { torrent: started.torrent } : {}),
      ...(started.torrent?.filePath ? { sourceTorrentPath: started.torrent.filePath } : {}),
      ...(started.reviewDraft ? { reviewDraft: started.reviewDraft } : {}),
      ...(mediaPath ? { mediaPath } : {}),
      workingDirectory: jobRoot
    },
    contextOptions
  );

  const outputs = await new PhaseRunner().runUploadTail(phaseContext);
  const phaseRuns = mergePhaseRuns(started, outputs);
  const upload = outputs.upload;
  if (upload?.status === "completed" && upload.result) {
    const uploadArtifacts: Partial<Job["artifacts"]> = {};
    const seedInfoHash = outputs["post-hook"]?.infoHash;
    if (seedInfoHash) uploadArtifacts.qbSeedInfoHash = seedInfoHash;
    return context.jobs.markUploadResult(id, upload.result, phaseRuns, uploadArtifacts);
  }
  return context.jobs.markUploadFailed(id, upload?.message ?? "PTP upload did not complete.", phaseRuns);
}

export async function retryFailedJob(context: JobActionContext, id: string): Promise<Job | null> {
  const existing = await context.jobs.get(id);
  if (!existing) return null;
  if (existing.state === "needs_reseed") return reseedJob(context, id);
  return context.jobs.retryFailed(id);
}

export async function retryCompletedPhaseJob(context: JobActionContext, id: string, phase: UploadPhase): Promise<Job | null> {
  if (phase === "post-hook") {
    const queued = await context.jobs.retryCompletedPhase(id, phase);
    if (!queued) return null;
    return reseedJob(context, id);
  }
  return context.getPreparation().retryCompletedPhase(id, phase);
}

export async function reseedJob(context: JobActionContext, id: string): Promise<Job | null> {
  const existing = await context.jobs.get(id);
  if (!existing) return null;
  const torrentClient = context.getTorrentClient();
  if (!torrentClient) {
    return context.jobs.markNeedsReseed(existing.id, "qBittorrent is not configured for automatic reseed.");
  }

  const config = context.config();
  const jobRoot = existing.workspace?.jobRoot ?? buildJobWorkspacePaths(config.paths.dataRoot, existing.id).jobRoot;
  const torrentPath = path.join(jobRoot, existing.artifacts.uploadTorrent ?? "torrent/upload.torrent");
  const downloadPath = path.join(jobRoot, "media", "upload");
  try {
    const addOptions: Parameters<TorrentDownloadClient["addTorrent"]>[0] = {
      torrentPath,
      downloadPath,
      skipHashCheck: true
    };
    if (config.integrations.qbittorrentCategory) addOptions.category = config.integrations.qbittorrentCategory;
    if (config.integrations.qbittorrentTags.length) addOptions.tags = config.integrations.qbittorrentTags;
    const result = await torrentClient.addTorrent(addOptions);
    return context.jobs.markReseeded(existing.id, result.infoHash);
  } catch {
    return context.jobs.markNeedsReseed(existing.id, "reseed failed");
  }
}

export async function resumeJob(context: JobActionContext, id: string): Promise<Job | null> {
  const job = await context.jobs.resume(id);
  if (job?.state === "preparing") context.enqueuePreparation(id);
  return job;
}

export async function skipJob(context: JobActionContext, id: string): Promise<Job | null> {
  return context.jobs.skip(id);
}
