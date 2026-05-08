import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildJobWorkspacePaths } from "@popcorn-queue/core";
import { JobRepository, type JobPhase, type PhaseState } from "./jobs.js";
import { PreparationService, computePreparationReviewStatus } from "./preparation.js";

describe("PreparationService", () => {
  it("runs a created job to review and writes job logs without uploading", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-prep-"));
    const jobs = new JobRepository();
    const job = jobs.create({
      candidate: {
        site: "mteam",
        title: "Movie.2024.1080p.BluRay.x264-GROUP",
        imdbId: "tt1234567"
      }
    });

    const service = new PreparationService({
      dataRoot,
      jobs,
      runExternalTools: false,
      toolCommands: { ffmpeg: "ffmpeg", mediainfo: "mediainfo", oxipng: "oxipng" }
    });

    await service.runJob(job.id);
    const prepared = jobs.get(job.id)!;

    expect(prepared.state).toBe("review");
    expect(prepared.phase).toBe("review");
    expect(prepared.uploadReadiness).not.toBe("blocked");
    expect(prepared.events.some((event) => event.message === "Upload package ready for review.")).toBe(true);
    expect(prepared.events.some((event) => event.message.includes("uploaded to PTP"))).toBe(false);
  });

  it("downloads through an injected torrent client and prepares upload media without PTP submit", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-prep-qb-"));
    const jobs = new JobRepository();
    const job = jobs.create({
      candidate: {
        site: "pter",
        title: "Movie.2024.1080p.WEB-DL.x265-GROUP",
        imdbId: "tt1234567"
      },
      torrent: {
        filename: "source.torrent",
        bytes: 13,
        filePath: path.join(dataRoot, "jobs", "job-source.torrent")
      }
    });
    const downloadDir = path.join(dataRoot, "jobs", job.id, "download", "Movie.2024.1080p.WEB-DL.x265-GROUP");
    const downloadedMedia = path.join(downloadDir, "Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await mkdir(downloadDir, { recursive: true });
    await writeFile(job.torrent!.filePath!, "source torrent");
    await writeFile(downloadedMedia, "movie");

    const addCalls: Array<{ torrentPath: string; downloadPath: string }> = [];
    const service = new PreparationService({
      dataRoot,
      jobs,
      runExternalTools: false,
      toolCommands: { ffmpeg: "ffmpeg", mediainfo: "mediainfo", oxipng: "oxipng" },
      torrentClient: {
        name: "mock-qb",
        async addTorrent(options) {
          addCalls.push({ torrentPath: options.torrentPath, downloadPath: options.downloadPath });
          return { infoHash: "ABC123" };
        },
        async getStatus(infoHash) {
          return {
            client: "mock-qb",
            infoHash,
            state: "uploading",
            progress: 1,
            downloaded: 5,
            size: 5,
            amountLeft: 0,
            downloadSpeed: 0,
            uploadSpeed: 0,
            eta: 0,
            seeds: 1,
            peers: 0,
            savePath: null,
            contentPath: null,
            lastUpdatedAt: "2026-05-08T00:00:00.000Z",
            error: null
          };
        },
        async isComplete(infoHash) {
          return infoHash === "ABC123";
        },
        async listFiles() {
          return [{ name: "Movie.2024.1080p.WEB-DL.x265-GROUP/Movie.2024.1080p.WEB-DL.x265-GROUP.mkv", size: 5 }];
        }
      }
    });

    await service.runJob(job.id);
    const prepared = jobs.get(job.id)!;

    expect(addCalls).toEqual([{ torrentPath: job.torrent!.filePath!, downloadPath: path.join(dataRoot, "jobs", job.id, "download") }]);
    expect(prepared.state).toBe("review");
    expect(prepared.uploadReadiness).toBe("missing_evidence");
    expect(prepared.artifacts.mediaFiles?.[0]).toMatch(/^media[/\\]upload[/\\]Movie\.2024/);
    expect(prepared.artifacts.uploadTorrent).toBe("torrent/upload.torrent");
    expect(prepared.artifacts.qbReady).toBe(true);
    expect(prepared.artifacts.reviewBlockers).toContain("Missing text MediaInfo or BDInfo");
    expect(prepared.artifacts.reviewBlockers).toContain("Missing screenshot evidence");
    expect(prepared.events.some((event) => event.message.includes("uploaded to PTP"))).toBe(false);
  });

  it("computes review blockers and warnings from evidence and draft fields", () => {
    const repo = new JobRepository();
    const job = repo.create({
      candidate: {
        site: "pter",
        title: "Movie.2024.1080p.WEB-DL.x265-GROUP",
        imdbId: "tt1234567"
      },
      checkResult: {
        candidate: {
          site: "pter",
          title: "Movie.2024.1080p.WEB-DL.x265-GROUP",
          imdbId: "tt1234567"
        },
        parsed: null,
        decision: {
          status: "open",
          movieFound: true,
          reason: "slot open",
          confidence: "high",
          ptpUrl: "https://passthepopcorn.me/torrents.php?id=123"
        },
        cache: { key: "ptp:imdb:tt1234567", hit: false, policy: "permanent" }
      }
    });
    const completeArtifacts = {
      mediaFiles: ["media/upload/Movie.mkv"],
      mediaInfoText: "General\nFormat                                   : Matroska",
      mediainfo: "General\nFormat                                   : Matroska",
      screenshots: ["https://img.example/1.png", "https://img.example/2.png", "https://img.example/3.png"],
      uploadTorrent: "torrent/upload.torrent",
      releaseName: "Movie.2024.1080p.WEB.x265-GROUP",
      description: "Description"
    };

    const readyWithWarning = computePreparationReviewStatus(job, completeArtifacts);
    expect(readyWithWarning.readiness).toBe("ready");
    expect(readyWithWarning.blockers).toEqual([]);
    expect(readyWithWarning.warnings).toContain("Missing JSON MediaInfo for internal parsing");

    const { mediaInfoText: _mediaInfoText, mediainfo: _mediainfo, ...withoutTextInfo } = completeArtifacts;
    const bdInfoOnly = computePreparationReviewStatus(job, {
      ...withoutTextInfo,
      bdinfo: "BDInfo"
    });
    expect(bdInfoOnly.readiness).toBe("ready");
    expect(bdInfoOnly.blockers).not.toContain("Missing text MediaInfo or BDInfo");

    const missingHostedScreenshots = computePreparationReviewStatus(job, {
      ...completeArtifacts,
      screenshots: ["screenshots/raw/1.png", "https://img.example/2.jpg"]
    });
    expect(missingHostedScreenshots.readiness).toBe("missing_evidence");
    expect(missingHostedScreenshots.blockers).toContain("Missing screenshot evidence");

    const missingDraftJob = repo.create({
      candidate: {
        site: "unknown",
        title: "Untitled.Release",
        imdbId: null
      }
    });
    const missingDraft = computePreparationReviewStatus(missingDraftJob, completeArtifacts);
    expect(missingDraft.readiness).toBe("missing_evidence");
    expect(missingDraft.blockers).toContain("Missing draft field: imdb");
    expect(missingDraft.blockers).toContain("Missing draft field: year");
  });

  it("stores qBittorrent progress snapshots and throttles readable download logs", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-prep-qb-progress-"));
    const jobs = new JobRepository();
    const job = jobs.create({
      candidate: {
        site: "pter",
        title: "Progress.Movie.2024.1080p.WEB-DL.x265-GROUP",
        imdbId: "tt1234567"
      },
      torrent: {
        filename: "source.torrent",
        bytes: 13,
        filePath: path.join(dataRoot, "jobs", "job-source.torrent")
      }
    });
    const paths = buildJobWorkspacePaths(dataRoot, job.id);
    const downloadDir = path.join(paths.sourceDownloadDir, "Progress.Movie.2024.1080p.WEB-DL.x265-GROUP");
    const downloadedMedia = path.join(downloadDir, "Progress.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await mkdir(downloadDir, { recursive: true });
    await mkdir(path.dirname(job.torrent!.filePath!), { recursive: true });
    await writeFile(job.torrent!.filePath!, "source torrent");
    await writeFile(downloadedMedia, "movie");

    const progressPoints = [0, 0.01, 0.049, 0.05, 0.099, 0.1, 1];
    let statusIndex = 0;
    const service = new PreparationService({
      dataRoot,
      jobs,
      runExternalTools: false,
      toolCommands: { ffmpeg: "ffmpeg", mediainfo: "mediainfo", oxipng: "oxipng" },
      torrentClientOptions: {
        waitTimeoutMs: 1000,
        waitIntervalMs: 1
      },
      torrentClient: {
        name: "mock-qb",
        async addTorrent() {
          return { infoHash: "PROGRESS" };
        },
        async getStatus(infoHash) {
          const progress = progressPoints[Math.min(statusIndex, progressPoints.length - 1)]!;
          statusIndex += 1;
          return {
            client: "mock-qb",
            infoHash,
            state: progress === 1 ? "uploading" : "downloading",
            progress,
            downloaded: Math.round(10_000 * progress),
            size: 10_000,
            amountLeft: Math.round(10_000 * (1 - progress)),
            downloadSpeed: progress === 1 ? 0 : 8_388_608,
            uploadSpeed: 0,
            eta: progress === 1 ? 0 : 720,
            seeds: 12,
            peers: 3,
            savePath: paths.sourceDownloadDir,
            contentPath: downloadedMedia,
            lastUpdatedAt: "2026-05-08T00:00:00.000Z",
            error: null
          };
        },
        async isComplete() {
          return false;
        },
        async listFiles() {
          return [{ name: "Progress.Movie.2024.1080p.WEB-DL.x265-GROUP/Progress.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv", size: 10_000 }];
        }
      }
    });

    await service.runJob(job.id);
    const prepared = jobs.get(job.id)!;
    const jobLog = await readFile(paths.logs.jobLog, "utf8");
    const downloadLines = jobLog.split(/\r?\n/).filter((line) => line.includes("Download "));

    expect(prepared.downloadStatus).toMatchObject({ infoHash: "PROGRESS", progress: 1, state: "uploading" });
    expect(jobLog).toContain("Download progress: 0%.");
    expect(jobLog).toContain("Download progress: 5%.");
    expect(jobLog).toContain("Download progress: 10%.");
    expect(jobLog).toContain("Download complete.");
    expect(downloadLines).toHaveLength(4);
  });

  it("persists preparation phase progress while the runner advances", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-prep-phase-progress-"));
    const repo = new JobRepository();
    const job = repo.create({
      candidate: {
        site: "mteam",
        title: "Phase.Progress.2024.1080p.WEB-DL.x265-GROUP",
        imdbId: "tt1234567"
      }
    });
    const starts: JobPhase[] = [];
    const finishes: Array<{ phase: JobPhase; state: PhaseState; message: string }> = [];
    const jobs = {
      get: (id: string) => repo.get(id),
      updateDownloadStatus: (id: string, status: Parameters<JobRepository["updateDownloadStatus"]>[1]) => repo.updateDownloadStatus(id, status),
      markPreparedForReview: (id: string, input: Parameters<JobRepository["markPreparedForReview"]>[1]) => repo.markPreparedForReview(id, input),
      markPreparationResult: (id: string, input: Parameters<JobRepository["markPreparationResult"]>[1]) => repo.markPreparationResult(id, input),
      markPreparationPhaseStarted: async (_id: string, phase: JobPhase) => {
        starts.push(phase);
        return repo.get(job.id);
      },
      markPreparationPhaseFinished: async (_id: string, input: { phase: JobPhase; state: PhaseState; message: string }) => {
        finishes.push(input);
        return repo.get(job.id);
      }
    };

    const service = new PreparationService({
      dataRoot,
      jobs,
      runExternalTools: false,
      toolCommands: { ffmpeg: "ffmpeg", mediainfo: "mediainfo", oxipng: "oxipng" }
    });

    await service.runJob(job.id);

    expect(starts).toContain("screenshots");
    expect(finishes).toContainEqual({ phase: "screenshots", state: "done", message: "Screenshot plan prepared." });
  });

  it("uses the Shock Wave fixture to prepare media evidence, torrent handoff, and a PTP draft without submitting", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-prep-fixture-"));
    const sourceFixture = path.resolve("apps/worker/fixtures/shock-wave-2-sample.mp4");
    const jobs = new JobRepository();
    const sourceTorrentPath = path.join(dataRoot, "jobs", "source.torrent");
    await mkdir(path.dirname(sourceTorrentPath), { recursive: true });
    await writeFile(sourceTorrentPath, "d4:infod6:lengthi5e4:name9:movie.mp4ee");
    const job = jobs.create({
      candidate: {
        site: "pter",
        title: "Shock.Wave.2.2020.1080p.WEB-DL.HEVC.HDR.DDP5.1-HVAC",
        imdbId: "tt9597838",
        resolution: "1080p"
      },
      checkResult: {
        candidate: {
          site: "pter",
          title: "Shock.Wave.2.2020.1080p.WEB-DL.HEVC.HDR.DDP5.1-HVAC",
          imdbId: "tt9597838",
          resolution: "1080p"
        },
        parsed: null,
        decision: {
          status: "open",
          movieFound: true,
          reason: "1080p HDR x265 slot is open.",
          confidence: "high",
          ptpUrl: "https://passthepopcorn.me/torrents.php?id=123"
        },
        cache: {
          key: "ptp:imdb:tt9597838",
          hit: false,
          policy: "permanent"
        }
      },
      torrent: {
        filename: "source.torrent",
        bytes: 36,
        filePath: sourceTorrentPath
      }
    });
    const uploadedImages: string[] = [];
    const service = new PreparationService({
      dataRoot,
      jobs,
      runExternalTools: true,
      toolCommands: { ffmpeg: "ffmpeg", mediainfo: "/home/emt/ptp/opt/mediainfo-23.06/bin/mediainfo", oxipng: "oxipng" },
      imageUploader: {
        name: "imgbb",
        async uploadImage(filePath) {
          uploadedImages.push(filePath);
          return {
            host: "imgbb",
            url: `https://imgbb.test/${path.basename(filePath)}`,
            viewerUrl: `https://imgbb.test/view/${path.basename(filePath)}`,
            deleteUrl: null,
            width: 320,
            height: 180
          };
        }
      },
      torrentClient: {
        name: "mock-qb",
        async addTorrent(options) {
          await copyFile(sourceFixture, path.join(options.downloadPath, path.basename(sourceFixture)));
          return { infoHash: "FIXTURE" };
        },
        async getStatus(infoHash) {
          return {
            client: "mock-qb",
            infoHash,
            state: "uploading",
            progress: 1,
            downloaded: 26_535,
            size: 26_535,
            amountLeft: 0,
            downloadSpeed: 0,
            uploadSpeed: 0,
            eta: 0,
            seeds: 1,
            peers: 0,
            savePath: null,
            contentPath: null,
            lastUpdatedAt: "2026-05-08T00:00:00.000Z",
            error: null
          };
        },
        async isComplete(infoHash) {
          return infoHash === "FIXTURE";
        },
        async listFiles() {
          return [{ name: path.basename(sourceFixture), size: 26_535, progress: 1 }];
        }
      }
    });

    await service.runJob(job.id);
    const prepared = jobs.get(job.id)!;
    const manifest = JSON.parse(await readFile(path.join(dataRoot, "jobs", job.id, "manifest.json"), "utf8")) as { uploadFiles: string[]; torrentFile: string | null };

    expect(prepared.state).toBe("review");
    expect(prepared.uploadReadiness).toBe("ready");
    expect(prepared.artifacts.mediaFiles?.[0]).toMatch(/^media[/\\]upload[/\\]shock-wave-2-sample\.mkv$/);
    expect(prepared.artifacts.mediaInfoText).toContain("Matroska");
    expect(prepared.artifacts.mediaInfoJson).toContain("\"media\"");
    expect(prepared.artifacts.mediainfo).toBe(prepared.artifacts.mediaInfoText);
    expect(prepared.artifacts.mediainfo).toContain("Matroska");
    expect(prepared.artifacts.screenshots).toHaveLength(6);
    expect(prepared.artifacts.screenshots?.every((url) => url.startsWith("https://imgbb.test/"))).toBe(true);
    expect(uploadedImages).toHaveLength(6);
    expect(prepared.artifacts.uploadTorrent).toBe("torrent/upload.torrent");
    expect(prepared.artifacts.qbReady).toBe(true);
    expect(prepared.artifacts.description).toContain("Shock.Wave.2.2020.1080p.WEB.x265.HDR-HVAC");
    expect(prepared.artifacts.description).toContain("1080p HDR x265 slot is open.");
    expect(prepared.phases.find((phase) => phase.phase === "prepare-media")).toMatchObject({ state: "done" });
    expect(prepared.phases.find((phase) => phase.phase === "screenshots")).toMatchObject({ state: "done" });
    expect(prepared.phases.find((phase) => phase.phase === "seed-prepare")).toMatchObject({ state: "done" });
    expect(manifest.uploadFiles).toEqual(prepared.artifacts.mediaFiles);
    expect(manifest.torrentFile).toBe("torrent/upload.torrent");
    expect(prepared.events.some((event) => event.message.includes("uploaded to PTP"))).toBe(false);
  });
});
