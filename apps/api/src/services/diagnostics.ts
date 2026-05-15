import { stat, statfs } from "node:fs/promises";
import path from "node:path";
import { checkWorkerTools, type CommandExecutor, type WorkerTool } from "@popcorn-queue/worker";
import type { ApiConfig } from "../config.js";
import type { Job } from "../jobs.js";

export type DiagnosticCheckStatus = "not_checked" | "ok" | "configured" | "missing" | "failed" | "disabled";
export type DiagnosticCheckTarget = "qbittorrent" | "ptp" | "image-host" | "tools";

export function sqliteDatabasePath(): string | null {
  const databaseUrl = process.env.DATABASE_URL ?? "file:./popcorn-queue.db";
  if (!databaseUrl.startsWith("file:")) return null;
  const filePath = databaseUrl.slice("file:".length);
  if (!filePath || filePath.startsWith(":")) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

export async function fileSize(filePath: string | null): Promise<number | null> {
  if (!filePath) return null;
  try {
    return (await stat(filePath)).size;
  } catch {
    return null;
  }
}

export async function freeBytes(filePath: string): Promise<number | null> {
  try {
    const info = await statfs(filePath);
    return info.bavail * info.bsize;
  } catch {
    return null;
  }
}

export async function cacheEntryCount(cache: unknown): Promise<number | null> {
  const maybeCount = (cache as { count?: () => Promise<number> }).count;
  if (!maybeCount) return null;
  try {
    return await maybeCount.call(cache);
  } catch {
    return null;
  }
}

export function integrationSummary(config: ApiConfig, target: DiagnosticCheckTarget): { configured: boolean; status: DiagnosticCheckStatus; detail: string } {
  if (target === "qbittorrent") {
    const configured = Boolean(config.integrations.qbittorrentUrl);
    return {
      configured,
      status: "not_checked",
      detail: configured ? "qBittorrent is configured." : "qBittorrent URL is not configured."
    };
  }
  if (target === "ptp") {
    const configured = Boolean(config.ptp.apiUser && config.ptp.apiKey);
    return {
      configured,
      status: "not_checked",
      detail: configured ? "PTP API credentials are configured." : "PTP API user/key are not configured."
    };
  }
  if (target === "image-host") {
    const configured = (config.integrations.imageHost === "imgbb" && Boolean(config.integrations.imgbbApiKey)) || Boolean(config.integrations.ptpImgApiKey);
    return {
      configured,
      status: "not_checked",
      detail: configured ? `${config.integrations.imageHost || "image host"} is configured.` : "No image host API key is configured."
    };
  }
  return {
    configured: config.integrations.runExternalTools,
    status: "not_checked",
    detail: config.integrations.runExternalTools ? "External media tools are enabled." : "External tools are disabled."
  };
}

export function toolCommandMap(config: ApiConfig): Partial<Record<WorkerTool, string>> {
  return {
    ffmpeg: config.integrations.ffmpegBin,
    mediainfo: config.integrations.mediainfoBin,
    mkvmerge: config.integrations.mkvmergeBin,
    mpv: config.integrations.mpvBin,
    oxipng: config.integrations.oxipngBin,
    "xvfb-run": config.integrations.xvfbRunBin
  };
}

export function toolCheckStatus(tools: Awaited<ReturnType<typeof checkWorkerTools>>): DiagnosticCheckStatus {
  return Object.values(tools).every((tool) => tool.available) ? "ok" : "failed";
}

export async function collectToolDiagnostics(config: ApiConfig, commandExecutor?: CommandExecutor) {
  return checkWorkerTools(commandExecutor, toolCommandMap(config));
}

export function queueDiagnostics(jobs: Job[]) {
  const counts = {
    total: jobs.length,
    preparing: 0,
    review: 0,
    failed: 0,
    done: 0,
    paused: 0,
    uploading: 0,
    seeding: 0,
    needsReseed: 0
  };
  const staleCutoff = Date.now() - 30 * 60 * 1000;
  const stuck: Array<{ id: string; state: string; phase: string; updatedAt: string; title: string }> = [];
  const recentFailures: Array<{ id: string; message: string; title: string }> = [];

  for (const job of jobs) {
    if (job.state === "preparing") counts.preparing += 1;
    else if (job.state === "review") counts.review += 1;
    else if (job.state === "failed") counts.failed += 1;
    else if (job.state === "done") counts.done += 1;
    else if (job.state === "paused") counts.paused += 1;
    else if (job.state === "uploading") counts.uploading += 1;
    else if (job.state === "seeding") counts.seeding += 1;
    else if (job.state === "needs_reseed") counts.needsReseed += 1;

    const updatedAt = Date.parse(job.updatedAt);
    if ((job.state === "preparing" || job.state === "uploading") && Number.isFinite(updatedAt) && updatedAt < staleCutoff) {
      stuck.push({ id: job.id, state: job.state, phase: job.phase, updatedAt: job.updatedAt, title: job.artifacts.releaseName ?? job.candidate?.title ?? job.source.title ?? job.id });
    }
    if (job.state === "failed") {
      recentFailures.push({ id: job.id, message: job.events.at(0)?.message ?? job.humanStep, title: job.artifacts.releaseName ?? job.candidate?.title ?? job.source.title ?? job.id });
    }
  }

  return {
    ...counts,
    stuck: stuck.slice(0, 10),
    recentFailures: recentFailures.slice(0, 10)
  };
}
