import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtpClient } from "@popcorn-queue/integrations";
import type { BrowserCheckResult, TorrentCandidate } from "@popcorn-queue/core";
import type { CommandExecutor } from "@popcorn-queue/worker";
import { JobRepository, type Job } from "./jobs.js";
import { authHeaders, multipartBody, pathExists, persistenceState, testConfig, waitForJob, withConfiguredServer, withServer } from "./server-test-utils.js";

describe("API job delete routes", () => {
  beforeEach(() => {
    persistenceState.initialJobs = [];
    vi.spyOn(PtpClient.prototype, "getGroup").mockResolvedValue({
      totalResults: 1,
      movies: [
        {
          GroupId: "205678",
          Title: "Manual Movie",
          Name: "Manual Movie",
          Year: "2024",
          ImdbId: "tt1234567",
          Torrents: []
        }
      ]
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires confirmation before deleting a job", async () => {
    const seedRepo = new JobRepository();
    const job = seedRepo.create({
      candidate: {
        site: "unknown",
        title: "Confirm.Delete.2024.1080p.WEB-DL.x265-GROUP"
      }
    });
    persistenceState.initialJobs = [job];

    await withServer(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/jobs/${job.id}/delete`,
        payload: { mode: "queue" }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: "delete_confirmation_required" });
    });
  });

  it("removes a job from the default queue without deleting the stored job", async () => {
    const seedRepo = new JobRepository();
    const job = seedRepo.create({
      candidate: {
        site: "unknown",
        title: "Archive.Delete.2024.1080p.WEB-DL.x265-GROUP"
      }
    });
    persistenceState.initialJobs = [job];

    await withServer(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/jobs/${job.id}/delete`,
        payload: { mode: "queue", confirm: true }
      });

      expect(response.statusCode).toBe(200);
      const removed = response.json<{ job: Job }>().job;
      expect(removed.artifacts.removedFromQueueAt).toEqual(expect.any(String));

      const list = await app.inject({ method: "GET", url: "/api/jobs" });
      expect(list.json<{ jobs: Job[] }>().jobs.map((item) => item.id)).not.toContain(job.id);

      const fetched = await app.inject({ method: "GET", url: `/api/jobs/${job.id}` });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json<{ job: Job }>().job.id).toBe(job.id);
    });
  });

  it("deletes only download files and safely removes the download torrent", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-delete-downloads-"));
    const jobRoot = path.join(dataRoot, "jobs", "delete-download-job");
    const downloadDir = path.join(jobRoot, "download");
    const uploadDir = path.join(jobRoot, "media", "upload");
    const downloadFile = path.join(downloadDir, "Source.Movie.mkv");
    const uploadFile = path.join(uploadDir, "Upload.Movie.mkv");
    await mkdir(downloadDir, { recursive: true });
    await mkdir(uploadDir, { recursive: true });
    await writeFile(downloadFile, "source");
    await writeFile(uploadFile, "upload");

    const seedRepo = new JobRepository();
    let job = seedRepo.create({
      candidate: {
        site: "unknown",
        title: "Delete.Downloads.2024.1080p.WEB-DL.x265-GROUP"
      }
    });
    job = seedRepo.markPreparedForReview(job.id, {
      uploadReadiness: "ready",
      artifacts: {
        mediaFiles: ["media/upload/Upload.Movie.mkv"],
        qbDownloadInfoHash: "DLHASH"
      }
    })!;
    job = seedRepo.attachWorkspace(job.id, {
      workspace: {
        dataRoot,
        jobRoot,
        manifest: path.join(jobRoot, "manifest.json")
      }
    })!;
    persistenceState.initialJobs = [job];
    const removed: Array<{ infoHash: string; deleteData?: boolean }> = [];

    await withConfiguredServer(
      { ...testConfig(), paths: { ...testConfig().paths, dataRoot } },
      {
        autoPrepare: false,
        torrentClient: {
          name: "mock-qb",
          async addTorrent() {
            throw new Error("addTorrent should not run during delete.");
          },
          async getStatus(infoHash) {
            return {
              client: "mock-qb",
              infoHash,
              state: "uploading",
              progress: 1,
              downloaded: 6,
              size: 6,
              amountLeft: 0,
              downloadSpeed: 0,
              uploadSpeed: 0,
              eta: 0,
              seeds: 1,
              peers: 0,
              savePath: downloadDir,
              contentPath: downloadFile,
              lastUpdatedAt: "2026-05-15T00:00:00.000Z",
              error: null
            };
          },
          async isComplete() {
            return true;
          },
          async listFiles() {
            return [];
          },
          async removeTorrent(infoHash, options) {
            const entry: { infoHash: string; deleteData?: boolean } = { infoHash };
            if (options?.deleteData !== undefined) entry.deleteData = options.deleteData;
            removed.push(entry);
          }
        }
      },
      async (app) => {
        const response = await app.inject({
          method: "POST",
          url: `/api/jobs/${job.id}/delete`,
          payload: { mode: "downloads", confirm: true }
        });

        expect(response.statusCode).toBe(200);
        const updated = response.json<{ job: Job }>().job;
        expect(updated.artifacts.downloadFilesDeletedAt).toEqual(expect.any(String));
        expect(await pathExists(downloadFile)).toBe(false);
        expect(await pathExists(uploadFile)).toBe(true);
        expect(await pathExists(jobRoot)).toBe(true);
        expect(removed).toEqual([{ infoHash: "DLHASH", deleteData: true }]);
      }
    );

    await rm(dataRoot, { recursive: true, force: true });
  });

  it("falls back to download status info hash when deleting download files", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-delete-download-status-"));
    const jobRoot = path.join(dataRoot, "jobs", "delete-download-status-job");
    const downloadDir = path.join(jobRoot, "download");
    const downloadFile = path.join(downloadDir, "Source.Movie.mkv");
    await mkdir(downloadDir, { recursive: true });
    await writeFile(downloadFile, "source");

    const seedRepo = new JobRepository();
    let job = seedRepo.create({
      candidate: {
        site: "unknown",
        title: "Delete.Download.Status.2024.1080p.WEB-DL.x265-GROUP"
      }
    });
    job = seedRepo.updateDownloadStatus(job.id, {
      client: "mock-qb",
      infoHash: "STATUSHASH",
      state: "stalledDL",
      progress: 0.25,
      downloaded: 1,
      size: 4,
      amountLeft: 3,
      downloadSpeed: 0,
      uploadSpeed: 0,
      eta: 0,
      seeds: 1,
      peers: 0,
      savePath: downloadDir,
      contentPath: downloadFile,
      lastUpdatedAt: "2026-05-15T00:00:00.000Z",
      error: null
    })!;
    job = seedRepo.attachWorkspace(job.id, {
      workspace: {
        dataRoot,
        jobRoot,
        manifest: path.join(jobRoot, "manifest.json")
      }
    })!;
    persistenceState.initialJobs = [job];
    const removed: Array<{ infoHash: string; deleteData?: boolean }> = [];

    await withConfiguredServer(
      { ...testConfig(), paths: { ...testConfig().paths, dataRoot } },
      {
        autoPrepare: false,
        torrentClient: {
          name: "mock-qb",
          async addTorrent() {
            throw new Error("addTorrent should not run during delete.");
          },
          async getStatus(infoHash) {
            return {
              client: "mock-qb",
              infoHash,
              state: "stalledDL",
              progress: 0.25,
              downloaded: 1,
              size: 4,
              amountLeft: 3,
              downloadSpeed: 0,
              uploadSpeed: 0,
              eta: 0,
              seeds: 1,
              peers: 0,
              savePath: downloadDir,
              contentPath: downloadFile,
              lastUpdatedAt: "2026-05-15T00:00:00.000Z",
              error: null
            };
          },
          async isComplete() {
            return false;
          },
          async listFiles() {
            return [];
          },
          async removeTorrent(infoHash, options) {
            const entry: { infoHash: string; deleteData?: boolean } = { infoHash };
            if (options?.deleteData !== undefined) entry.deleteData = options.deleteData;
            removed.push(entry);
          }
        }
      },
      async (app) => {
        const response = await app.inject({
          method: "POST",
          url: `/api/jobs/${job.id}/delete`,
          payload: { mode: "downloads", confirm: true }
        });

        expect(response.statusCode).toBe(200);
        const updated = response.json<{ job: Job }>().job;
        expect(updated.artifacts.downloadFilesDeletedAt).toEqual(expect.any(String));
        expect(await pathExists(downloadFile)).toBe(false);
        expect(removed).toEqual([{ infoHash: "STATUSHASH", deleteData: true }]);
      }
    );

    await rm(dataRoot, { recursive: true, force: true });
  });

  it("deletes the local job and cleans up download and seed torrents", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-delete-everything-"));
    const jobRoot = path.join(dataRoot, "jobs", "delete-everything-job");
    const downloadDir = path.join(jobRoot, "download");
    const uploadDir = path.join(jobRoot, "media", "upload");
    const downloadFile = path.join(downloadDir, "Source.Movie.mkv");
    const uploadFile = path.join(uploadDir, "Upload.Movie.mkv");
    await mkdir(downloadDir, { recursive: true });
    await mkdir(uploadDir, { recursive: true });
    await writeFile(downloadFile, "source");
    await writeFile(uploadFile, "upload");

    const seedRepo = new JobRepository();
    let job = seedRepo.create({
      candidate: {
        site: "unknown",
        title: "Delete.Everything.2024.1080p.WEB-DL.x265-GROUP"
      }
    });
    job = seedRepo.markPreparedForReview(job.id, {
      uploadReadiness: "ready",
      artifacts: {
        mediaFiles: ["media/upload/Upload.Movie.mkv"],
        qbDownloadInfoHash: "DLHASH",
        qbSeedInfoHash: "SEEDHASH"
      }
    })!;
    job = seedRepo.attachWorkspace(job.id, {
      workspace: {
        dataRoot,
        jobRoot,
        manifest: path.join(jobRoot, "manifest.json")
      }
    })!;
    persistenceState.initialJobs = [job];
    const removed: Array<{ infoHash: string; deleteData?: boolean }> = [];

    await withConfiguredServer(
      { ...testConfig(), paths: { ...testConfig().paths, dataRoot } },
      {
        autoPrepare: false,
        torrentClient: {
          name: "mock-qb",
          async addTorrent() {
            throw new Error("addTorrent should not run during delete.");
          },
          async getStatus(infoHash) {
            const seed = infoHash === "SEEDHASH";
            return {
              client: "mock-qb",
              infoHash,
              state: "uploading",
              progress: 1,
              downloaded: 6,
              size: 6,
              amountLeft: 0,
              downloadSpeed: 0,
              uploadSpeed: 0,
              eta: 0,
              seeds: 1,
              peers: 0,
              savePath: seed ? uploadDir : downloadDir,
              contentPath: seed ? uploadFile : downloadFile,
              lastUpdatedAt: "2026-05-15T00:00:00.000Z",
              error: null
            };
          },
          async isComplete() {
            return true;
          },
          async listFiles() {
            return [];
          },
          async removeTorrent(infoHash, options) {
            const entry: { infoHash: string; deleteData?: boolean } = { infoHash };
            if (options?.deleteData !== undefined) entry.deleteData = options.deleteData;
            removed.push(entry);
          }
        }
      },
      async (app) => {
        const response = await app.inject({
          method: "POST",
          url: `/api/jobs/${job.id}/delete`,
          payload: { mode: "everything", confirm: true }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ deleted: true, jobId: job.id });
        expect(await pathExists(jobRoot)).toBe(false);
        expect(removed).toEqual([
          { infoHash: "DLHASH", deleteData: true },
          { infoHash: "SEEDHASH", deleteData: true }
        ]);

        const fetched = await app.inject({ method: "GET", url: `/api/jobs/${job.id}` });
        expect(fetched.statusCode).toBe(404);
      }
    );

    await rm(dataRoot, { recursive: true, force: true });
  });
});
