import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JobRepository } from "./jobs.js";
import { PreparationService } from "./preparation.js";

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
    expect(prepared.uploadReadiness).toBe("ready");
    expect(prepared.artifacts.mediaFiles?.[0]).toMatch(/^media[/\\]upload[/\\]Movie\.2024/);
    expect(prepared.artifacts.uploadTorrent).toBe("torrent/upload.torrent");
    expect(prepared.artifacts.qbReady).toBe(true);
    expect(prepared.events.some((event) => event.message.includes("uploaded to PTP"))).toBe(false);
  });
});
