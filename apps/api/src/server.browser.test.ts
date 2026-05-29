import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtpClient } from "@popcorn-queue/integrations";
import type { BrowserCheckResult, TorrentCandidate } from "@popcorn-queue/core";
import type { CommandExecutor } from "@popcorn-queue/worker";
import { JobRepository, type Job } from "./jobs.js";
import { authHeaders, multipartBody, pathExists, persistenceState, testConfig, waitForJob, withConfiguredServer, withServer } from "./server-test-utils.js";

describe("API browser routes", () => {
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

  it("allows browser preflight for review draft saves", async () => {
    await withServer(async (app) => {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/api/jobs/job-1/review-draft",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "PATCH",
          "access-control-request-headers": "content-type"
        }
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
      expect(response.headers["access-control-allow-headers"]).toContain("content-type");
    });
  });

  it("allows remote dev browser origins on the configured web port for the same host as the API", async () => {
    const config = testConfig();
    config.allowedOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];

    await withConfiguredServer(config, { autoPrepare: false }, async (app) => {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/api/health",
        headers: {
          host: "203.0.113.10:3500",
          origin: "http://203.0.113.10:5173",
          "access-control-request-method": "GET"
        }
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("http://203.0.113.10:5173");
    });
  });

  it("creates browser upload jobs from multipart submissions", async () => {
    await rm(testConfig().paths.dataRoot, { recursive: true, force: true });
    await withServer(async (app) => {
      const boundary = "popcorn-queue-test-boundary";
      const candidate = {
        site: "mteam",
        title: "Test.Movie.2024.1080p.BluRay.x264-GROUP",
        subtitle: "NexusPHP subtitle from source tracker",
        imdbId: "tt1234567",
        resolution: "1080p",
        sourceUrl: "https://tracker.example/torrent/1"
      };
      const checkResult = {
        candidate,
        parsed: null,
        decision: {
          status: "full",
          movieFound: true,
          reason: "The matching slot is already full.",
          confidence: "high"
        },
        cache: {
          key: "ptp:imdb:tt1234567",
          hit: false,
          policy: "permanent"
        }
      };

      const response = await app.inject({
        method: "POST",
        url: "/api/browser/jobs",
        headers: {
          ...authHeaders,
          "content-type": `multipart/form-data; boundary=${boundary}`
        },
        payload: multipartBody(
          boundary,
          {
            candidate: JSON.stringify(candidate),
            checkResult: JSON.stringify(checkResult)
          },
          {
            name: "torrent",
            filename: "source.torrent",
            contentType: "application/x-bittorrent",
            value: "d4:infod6:lengthi1eee"
          }
        )
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(job.source).toMatchObject({ site: "mteam", url: "https://tracker.example/torrent/1", title: candidate.title, subtitle: candidate.subtitle });
      expect(job.candidate).toMatchObject({ subtitle: candidate.subtitle });
      expect(job.torrent).toMatchObject({ filename: "source.torrent", bytes: 21, contentType: "application/x-bittorrent" });
      expect(job.torrent?.filePath).toMatch(/torrent[/\\]source\.torrent$/);
      expect(job.workspace?.jobRoot).toContain(job.id);
      await expect(access(job.torrent!.filePath!)).resolves.toBeUndefined();
      expect(job.state).toBe("preparing");
      expect(job.uploadPlan.screenshots.imageHosts[0]).toBe("imgbb");
      expect(job.uploadPlan.reviewGates).toContainEqual(expect.objectContaining({ id: "duplicate:slot-full", severity: "blocker" }));
    });
  });

  it("preserves UTF-8 uploaded torrent filenames", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-upload-utf8-"));
    const mediaPath = path.join(root, "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await writeFile(mediaPath, "movie");
    const config = testConfig();
    const boundary = "popcorn-manual-intake-upload-utf8";
    const torrentFilename = "[M-TEAM][1129276]镇魔司：苍龙觉醒.Z.torrent";

    await withConfiguredServer(config, { autoPrepare: false }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(
          boundary,
          {
            mediaPath,
            ptpTarget: JSON.stringify({
              groupId: "205678",
              displayTitle: "Manual Movie [2024]",
              year: "2024",
              imdbId: "tt1234567",
              ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
            })
          },
          {
            name: "torrent",
            filename: torrentFilename,
            contentType: "application/x-bittorrent",
            value: "d4:infod6:lengthi1eee"
          }
        )
      });

      expect(response.statusCode).toBe(201);
      expect(response.json<{ job: Job }>().job.torrent?.filename).toBe(torrentFilename);
    });
  });

  it("repairs mojibake uploaded torrent filenames before storing jobs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-upload-mojibake-"));
    const mediaPath = path.join(root, "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await writeFile(mediaPath, "movie");
    const config = testConfig();
    const boundary = "popcorn-manual-intake-upload-mojibake";
    const torrentFilename = "[M-TEAM][1129276]镇魔司：苍龙觉醒.Z.torrent";
    const mojibakeFilename = Buffer.from(torrentFilename, "utf8").toString("latin1");

    await withConfiguredServer(config, { autoPrepare: false }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(
          boundary,
          {
            mediaPath,
            ptpTarget: JSON.stringify({
              groupId: "205678",
              displayTitle: "Manual Movie [2024]",
              year: "2024",
              imdbId: "tt1234567",
              ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
            })
          },
          {
            name: "torrent",
            filename: mojibakeFilename,
            contentType: "application/x-bittorrent",
            value: "d4:infod6:lengthi1eee"
          }
        )
      });

      expect(response.statusCode).toBe(201);
      expect(response.json<{ job: Job }>().job.torrent?.filename).toBe(torrentFilename);
    });
  });
});
