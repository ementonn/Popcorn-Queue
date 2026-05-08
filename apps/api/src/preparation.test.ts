import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
