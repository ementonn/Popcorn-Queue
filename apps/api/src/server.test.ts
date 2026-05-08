import { afterEach, describe, expect, it, vi } from "vitest";
import { PtpClient } from "@popcorn-queue/integrations";
import { buildServer } from "./server.js";
import type { ApiConfig } from "./config.js";
import type { BrowserCheckResult } from "@popcorn-queue/core";
import type { Job } from "./jobs.js";

vi.mock("./persistence.js", async () => {
  const { MemoryCacheStore } = await import("@popcorn-queue/core");
  const { JobRepository } = await import("./jobs.js");

  return {
    PrismaPersistence: class {
      readonly jobs;
      readonly ptpCache = new MemoryCacheStore();

      constructor(options: { jobs?: ConstructorParameters<typeof JobRepository>[1] } = {}) {
        this.jobs = new JobRepository([], options.jobs);
      }

      async disconnect(): Promise<void> {}
    }
  };
});

const authHeaders = { authorization: "Bearer test-browser-token" };

function testConfig(): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    browserToken: "test-browser-token",
    allowedOrigins: [],
    publicWebUrl: "http://localhost:5173",
    publicApiUrl: "http://localhost:3500",
    ptp: {
      apiUser: "api-user",
      apiKey: "api-key",
      username: "",
      password: "",
      baseUrl: "https://passthepopcorn.me/torrents.php",
      userAgent: "Popcorn Queue Test",
      requestDelayMs: 0,
      announceUrl: "",
      cookieFile: ""
    },
    integrations: {
      imageHost: "imgbb",
      imgbbApiKey: "imgbb-key",
      tmdbApiKey: "",
      ptpImgApiKey: "",
      qbittorrentUrl: "",
      qbittorrentUsername: "",
      qbittorrentPassword: "",
      qbittorrentTags: [],
      qbittorrentCategory: "",
      qbittorrentContentLayout: "",
      runExternalTools: false,
      ffmpegBin: "ffmpeg",
      mediainfoBin: "mediainfo",
      oxipngBin: "oxipng",
      workDir: "./data/work",
      outputDir: "./data/output"
    },
    logging: {
      level: "silent",
      file: "",
      toFile: false,
      toConsole: false
    }
  };
}

async function withServer<T>(run: (app: ReturnType<typeof buildServer>) => Promise<T>): Promise<T> {
  const app = buildServer(testConfig());
  try {
    await app.ready();
    return await run(app);
  } finally {
    await app.close();
  }
}

function multipartBody(boundary: string, fields: Record<string, string>, file: { name: string; filename: string; contentType: string; value: string }): Buffer {
  const chunks: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  chunks.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n${file.value}\r\n`
  );
  chunks.push(`--${boundary}--\r\n`);
  return Buffer.from(chunks.join(""));
}

describe("API cache contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports permanent cache policy", async () => {
    await withServer(async (app) => {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: true, cachePolicy: "permanent", external: { imageHost: "imgbb", imgbbConfigured: true } });

      const features = await app.inject({ method: "GET", url: "/api/features" });
      const ptpCache = features.json<{ features: Array<{ id: string; detail: string }> }>().features.find((feature) => feature.id === "ptp-cache");
      expect(ptpCache?.detail).toContain("permanently");
      expect(ptpCache?.detail).not.toMatch(/\b30\b|\bday/i);
    });
  });

  it("reuses browser check results from permanent cache until invalidated", async () => {
    const search = vi.spyOn(PtpClient.prototype, "searchByCandidate").mockResolvedValue({ movies: [] });

    await withServer(async (app) => {
      const candidate = {
        site: "mteam",
        title: "Interstellar.2014.1080p.BluRay.x264-GROUP",
        imdbId: "tt0816692",
        resolution: "1080p"
      };

      const first = await app.inject({ method: "POST", url: "/api/browser/check", headers: authHeaders, payload: candidate });
      expect(first.statusCode).toBe(200);
      const firstResult = first.json<{ result: BrowserCheckResult }>().result;
      expect(firstResult.cache).toMatchObject({ hit: false, key: "ptp:imdb:tt0816692", policy: "permanent" });

      const second = await app.inject({ method: "POST", url: "/api/browser/check", headers: authHeaders, payload: candidate });
      expect(second.statusCode).toBe(200);
      const secondResult = second.json<{ result: BrowserCheckResult }>().result;
      expect(secondResult.cache).toMatchObject({ hit: true, key: "ptp:imdb:tt0816692", policy: "permanent" });
      expect(secondResult.cache.cachedAt).toBeDefined();
      expect(search).toHaveBeenCalledTimes(1);

      const invalidate = await app.inject({ method: "POST", url: "/api/browser/cache/invalidate", headers: authHeaders, payload: candidate });
      expect(invalidate.statusCode).toBe(200);

      const third = await app.inject({ method: "POST", url: "/api/browser/check", headers: authHeaders, payload: candidate });
      expect(third.statusCode).toBe(200);
      expect(third.json<{ result: BrowserCheckResult }>().result.cache.hit).toBe(false);
      expect(search).toHaveBeenCalledTimes(2);
    });
  });
});

describe("API jobs", () => {
  it("creates browser upload jobs from multipart submissions", async () => {
    await withServer(async (app) => {
      const boundary = "popcorn-queue-test-boundary";
      const candidate = {
        site: "mteam",
        title: "Test.Movie.2024.1080p.BluRay.x264-GROUP",
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
      expect(job.source).toMatchObject({ site: "mteam", url: "https://tracker.example/torrent/1", title: candidate.title });
      expect(job.torrent).toMatchObject({ filename: "source.torrent", bytes: 21, contentType: "application/x-bittorrent" });
      expect(job.state).toBe("preparing");
      expect(job.uploadPlan.screenshots.imageHosts[0]).toBe("imgbb");
      expect(job.uploadPlan.reviewGates).toContainEqual(expect.objectContaining({ id: "duplicate:slot-full", severity: "blocker" }));
    });
  });

  it("uses intent action routes for upload starts and debug advancement", async () => {
    await withServer(async (app) => {
      const create = await app.inject({
        method: "POST",
        url: "/api/jobs",
        payload: {
          site: "unknown",
          title: "Movie.2024.1080p.BluRay.x264-YIFY.mp4",
          imdbId: null
        }
      });
      expect(create.statusCode).toBe(201);
      let job = create.json<{ job: Job }>().job;
      expect(job.state).toBe("preparing");
      expect(job.phase).toBe("intake");

      const blocked = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/debug/advance` });
      expect(blocked.statusCode).toBe(200);
      job = blocked.json<{ job: Job }>().job;
      expect(job.state).toBe("review");
      expect(job.phases.find((phase) => phase.phase === "intake")).toMatchObject({ state: "warning" });

      for (const gate of job.uploadPlan.reviewGates) {
        const resolve = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/review-gates/${encodeURIComponent(gate.id)}/resolve` });
        expect(resolve.statusCode).toBe(200);
        job = resolve.json<{ job: Job }>().job;
      }

      expect(job.uploadPlan.reviewGates.every((gate) => gate.status === "resolved")).toBe(true);
      expect(job.state).toBe("review");

      const start = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/start-upload` });
      expect(start.statusCode).toBe(200);
      job = start.json<{ job: Job }>().job;
      expect(job.state).toBe("review");
      expect(job.events.at(0)?.message).toBe("Cannot start upload until blockers and required evidence are resolved.");

      const retry = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/retry-failed` });
      expect(retry.statusCode).toBe(200);
      job = retry.json<{ job: Job }>().job;
      expect(job.state).toBe("preparing");
      expect(job.events.at(0)?.message).toBe("Retry queued.");
    });
  });
});
