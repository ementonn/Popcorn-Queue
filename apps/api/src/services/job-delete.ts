import { rm } from "node:fs/promises";
import path from "node:path";
import { buildJobWorkspacePaths } from "@popcorn-queue/core";
import type { TorrentDownloadClient } from "@popcorn-queue/worker";
import type { ApiConfig } from "../config.js";
import type { Job } from "../jobs.js";
import type { PrismaPersistence } from "../persistence.js";

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

function jobRootPath(config: ApiConfig, job: Job): string {
  return job.workspace?.jobRoot ?? buildJobWorkspacePaths(config.paths.dataRoot, job.id).jobRoot;
}

function isInsideOrEqual(parentPath: string, childPath: string | null | undefined): boolean {
  if (!childPath) return false;
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

async function removeLocalPath(targetPath: string): Promise<JobDeleteCleanupResult["localPaths"][number]> {
  try {
    await rm(targetPath, { recursive: true, force: true });
    return { path: targetPath, status: "deleted", message: "Deleted." };
  } catch (error) {
    return { path: targetPath, status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

async function removeJobTorrent(
  client: TorrentDownloadClient | null,
  infoHash: string | null | undefined,
  role: "download" | "seed",
  deleteDataRoot: string
): Promise<TorrentCleanupResult | null> {
  if (!infoHash) return null;
  if (!client?.removeTorrent) {
    return {
      infoHash,
      role,
      status: "skipped",
      deleteData: false,
      message: "Torrent client removal is not configured."
    };
  }

  let deleteData = false;
  try {
    const status = await client.getStatus(infoHash);
    deleteData = isInsideOrEqual(deleteDataRoot, status.contentPath) || isInsideOrEqual(deleteDataRoot, status.savePath);
  } catch {
    deleteData = false;
  }

  try {
    await client.removeTorrent(infoHash, { deleteData });
    return {
      infoHash,
      role,
      status: "removed",
      deleteData,
      message: deleteData ? "Torrent and managed data removed." : "Torrent removed without deleting external data."
    };
  } catch (error) {
    return {
      infoHash,
      role,
      status: "failed",
      deleteData,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function jobDownloadInfoHash(job: Job): string | null {
  return job.artifacts.qbDownloadInfoHash?.trim() || job.downloadStatus?.infoHash?.trim() || null;
}

async function deleteJobDownloads(config: ApiConfig, job: Job, client: TorrentDownloadClient | null): Promise<JobDeleteCleanupResult> {
  const jobRoot = jobRootPath(config, job);
  const downloadDirectory = path.join(jobRoot, "download");
  const torrents = [
    await removeJobTorrent(client, jobDownloadInfoHash(job), "download", downloadDirectory)
  ].filter((item): item is TorrentCleanupResult => Boolean(item));
  return {
    localPaths: [await removeLocalPath(downloadDirectory)],
    torrents
  };
}

async function deleteEntireJob(config: ApiConfig, job: Job, client: TorrentDownloadClient | null): Promise<JobDeleteCleanupResult> {
  const jobRoot = jobRootPath(config, job);
  const downloadDirectory = path.join(jobRoot, "download");
  const torrents = [
    await removeJobTorrent(client, jobDownloadInfoHash(job), "download", downloadDirectory),
    await removeJobTorrent(client, job.artifacts.qbSeedInfoHash, "seed", jobRoot)
  ].filter((item): item is TorrentCleanupResult => Boolean(item));
  return {
    localPaths: [await removeLocalPath(jobRoot)],
    torrents
  };
}

export async function deleteJob(input: {
  config: ApiConfig;
  jobs: PrismaPersistence["jobs"];
  torrentClient: TorrentDownloadClient | null;
  id: string;
  body: DeleteJobBody | undefined;
}): Promise<{ status: 200 | 400 | 404; body: unknown }> {
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
