import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtpClient } from "@popcorn-queue/integrations";
import { buildServer } from "./server.js";
import type { ApiConfig } from "./config.js";
import type { BrowserCheckResult } from "@popcorn-queue/core";
import type { CommandExecutor } from "@popcorn-queue/worker";
import type { Job } from "./jobs.js";

const persistenceState = vi.hoisted(() => ({
  initialJobs: [] as Job[]
}));

vi.mock("./persistence.js", async () => {
  const { MemoryCacheStore } = await import("@popcorn-queue/core");
  const { JobRepository } = await import("./jobs.js");

  class CountingMemoryCacheStore<T> extends MemoryCacheStore<T> {
    countValue = 0;

    override async set(key: string, data: T) {
      const existing = await this.get(key);
      const entry = await super.set(key, data);
      if (!existing) this.countValue += 1;
      return entry;
    }

    async count(): Promise<number> {
      return this.countValue;
    }
  }

  return {
    PrismaPersistence: class {
      readonly jobs;
      readonly ptpCache = new CountingMemoryCacheStore();

      constructor(options: { jobs?: ConstructorParameters<typeof JobRepository>[1] } = {}) {
        this.jobs = new JobRepository(persistenceState.initialJobs, options.jobs);
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
    webAuth: {
      enabled: false,
      sessionCookieName: "popcorn_session",
      sessionMaxAgeSeconds: 604800
    },
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
      announceUrl: "https://please.passthepopcorn.me/passkey/announce",
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
      qbittorrentDownloadWaitMs: 0,
      qbittorrentDownloadPollMs: 1,
      runExternalTools: false,
      ffmpegBin: "ffmpeg",
      mediainfoBin: "mediainfo",
      mkvmergeBin: "mkvmerge",
      oxipngBin: "oxipng",
      workDir: "./data/work",
      outputDir: "./data/output"
    },
    logging: {
      level: "silent",
      file: "",
      toFile: false,
      toConsole: false
    },
    paths: {
      dataRoot: "/tmp/popcorn-queue-test-data",
      apiLogFile: "/tmp/popcorn-queue-test-api.log",
      workerLogFile: "/tmp/popcorn-queue-test-worker.log"
    }
  };
}

async function withServer<T>(run: (app: ReturnType<typeof buildServer>) => Promise<T>, options: Parameters<typeof buildServer>[1] = { autoPrepare: false }): Promise<T> {
  const app = buildServer(testConfig(), options);
  try {
    await app.ready();
    return await run(app);
  } finally {
    await app.close();
  }
}

async function withConfiguredServer<T>(config: ApiConfig, options: Parameters<typeof buildServer>[1], run: (app: ReturnType<typeof buildServer>) => Promise<T>): Promise<T> {
  const app = buildServer(config, options);
  try {
    await app.ready();
    return await run(app);
  } finally {
    await app.close();
  }
}

async function waitForJob(app: ReturnType<typeof buildServer>, id: string, predicate: (job: Job) => boolean): Promise<Job> {
  let last: Job | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/jobs/${id}` });
    expect(response.statusCode).toBe(200);
    last = response.json<{ job: Job }>().job;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for job ${id}; last state ${last?.state ?? "unknown"}/${last?.phase ?? "unknown"}`);
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
  beforeEach(() => {
    persistenceState.initialJobs = [];
  });

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

  it("returns system diagnostics without worker log noise", async () => {
    const commandExecutor: CommandExecutor = async (invocation) => {
      if (invocation.command === "which") {
        const command = invocation.args[0] ?? "unknown";
        return {
          command: invocation.command,
          args: invocation.args,
          exitCode: 0,
          signal: null,
          stdout: `/usr/bin/${command}\n`,
          stderr: "",
          durationMs: 1
        };
      }
      return {
        command: invocation.command,
        args: invocation.args,
        exitCode: 0,
        signal: null,
        stdout: `${invocation.command} version test\n`,
        stderr: "",
        durationMs: 1
      };
    };

    await withServer(async (app) => {
      const create = await app.inject({
        method: "POST",
        url: "/api/jobs",
        payload: {
          site: "unknown",
          title: "Diagnostic.Movie.2024.1080p.WEB-DL.x265-GROUP",
          imdbId: "tt1234567"
        }
      });
      expect(create.statusCode).toBe(201);

      const diagnostics = await app.inject({ method: "GET", url: "/api/diagnostics" });
      expect(diagnostics.statusCode).toBe(200);
      expect(diagnostics.json()).toMatchObject({
        system: {
          api: "online",
          persistence: "sqlite",
          ptpApiConfigured: true,
          browserBridgeConfigured: true
        },
        integrations: {
          qbittorrent: { configured: false, status: "not_checked" },
          ptp: { configured: true, status: "not_checked" },
          imageHost: { configured: true, status: "not_checked" }
        },
        queue: {
          total: 1,
          preparing: 1,
          review: 0,
          failed: 0,
          done: 0
        },
        storage: {
          dataRoot: "/tmp/popcorn-queue-test-data",
          cacheEntries: 0,
          jobCount: 1
        },
        tools: {
          ffmpeg: { available: true, version: "ffmpeg version test", location: "/usr/bin/ffmpeg" },
          mediainfo: { available: true, version: "mediainfo version test", location: "/usr/bin/mediainfo" },
          mkvmerge: { available: true, version: "mkvmerge version test", location: "/usr/bin/mkvmerge" },
          oxipng: { available: true, version: "oxipng version test", location: "/usr/bin/oxipng" }
        },
        logs: {
          api: []
        }
      });
      expect(diagnostics.json()).not.toHaveProperty("logs.worker");
    }, { autoPrepare: false, commandExecutor });
  });

  it("runs manual diagnostic checks without contacting missing integrations", async () => {
    await withServer(async (app) => {
      const response = await app.inject({ method: "POST", url: "/api/diagnostics/check/qbittorrent" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        target: "qbittorrent",
        status: "missing",
        detail: "qBittorrent URL is not configured."
      });

      const tools = await app.inject({ method: "POST", url: "/api/diagnostics/check/tools" });
      expect(tools.statusCode).toBe(200);
      expect(tools.json()).toMatchObject({
        target: "tools",
        configured: false,
        status: "disabled",
        detail: "External tools are disabled."
      });
    });
  });

  it("returns hot-reloadable settings without exposing secret values or restart-only keys", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "popcorn-settings-"));
    const envPath = path.join(directory, ".env");
    await writeFile(
      envPath,
      [
        "DATABASE_URL=file:./private.db",
        "PTP_API_KEY=old-api-key",
        "QBITTORRENT_URL=127.0.0.1:10526",
        "POPCORN_QUEUE_RUN_EXTERNAL_TOOLS=true"
      ].join("\n") + "\n",
      "utf8"
    );

    const config = testConfig();
    config.ptp.apiKey = "old-api-key";
    config.integrations.qbittorrentUrl = "127.0.0.1:10526";
    config.integrations.runExternalTools = true;

    try {
      await withConfiguredServer(config, { autoPrepare: false, settingsEnvPath: envPath }, async (app) => {
        const response = await app.inject({ method: "GET", url: "/api/settings" });
        expect(response.statusCode).toBe(200);
        const settings = response.json<{
          envPath: string;
          fields: Array<{ key: string; secret: boolean; value: string; configured: boolean }>;
        }>();
        const keys = settings.fields.map((field) => field.key);

        expect(settings.envPath).toBe(envPath);
        expect(keys).toContain("PTP_API_KEY");
        expect(keys).toContain("QBITTORRENT_URL");
        expect(keys).toContain("POPCORN_QUEUE_RUN_EXTERNAL_TOOLS");
        expect(keys).not.toContain("DATABASE_URL");
        expect(keys).not.toContain("POPCORN_QUEUE_PORT");
        expect(settings.fields.find((field) => field.key === "PTP_API_KEY")).toMatchObject({
          secret: true,
          value: "",
          configured: true
        });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("saves settings to dotenv and hot reloads runtime configuration", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "popcorn-settings-"));
    const envPath = path.join(directory, ".env");
    await writeFile(
      envPath,
      [
        "DATABASE_URL=file:./private.db",
        "QBITTORRENT_URL=",
        "PTP_REQUEST_DELAY_MS=2000",
        "PTP_API_KEY=old-api-key"
      ].join("\n") + "\n",
      "utf8"
    );

    const config = testConfig();
    config.integrations.qbittorrentUrl = "";
    config.ptp.requestDelayMs = 2000;
    config.ptp.apiKey = "old-api-key";

    try {
      await withConfiguredServer(config, { autoPrepare: false, settingsEnvPath: envPath }, async (app) => {
        const save = await app.inject({
          method: "PATCH",
          url: "/api/settings",
          payload: {
            values: {
              QBITTORRENT_URL: "127.0.0.1:10526",
              PTP_REQUEST_DELAY_MS: "1234",
              PTP_API_KEY: "new-api-key"
            }
          }
        });
        expect(save.statusCode).toBe(200);
        expect(save.json()).toMatchObject({ saved: true, reloaded: true, restartRequired: false });

        const text = await readFile(envPath, "utf8");
        expect(text).toContain("DATABASE_URL=file:./private.db");
        expect(text).toContain("QBITTORRENT_URL=127.0.0.1:10526");
        expect(text).toContain("PTP_REQUEST_DELAY_MS=1234");
        expect(text).toContain("PTP_API_KEY=new-api-key");

        const health = await app.inject({ method: "GET", url: "/api/health" });
        expect(health.statusCode).toBe(200);
        expect(health.json()).toMatchObject({ external: { torrentClientConfigured: true } });

        const settings = await app.inject({ method: "GET", url: "/api/settings" });
        expect(settings.json<{ fields: Array<{ key: string; value: string; configured: boolean }> }>().fields.find((field) => field.key === "PTP_API_KEY")).toMatchObject({
          value: "",
          configured: true
        });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("protects web API routes with local PTP username and password sessions", async () => {
    const config = testConfig();
    config.webAuth.enabled = true;
    config.ptp.username = "ptp-user";
    config.ptp.password = "ptp-pass";

    await withConfiguredServer(config, { autoPrepare: false }, async (app) => {
      const anonymous = await app.inject({ method: "GET", url: "/api/jobs" });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toMatchObject({ error: "web_auth_required" });

      const wrong = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "ptp-user", password: "wrong" }
      });
      expect(wrong.statusCode).toBe(401);

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "ptp-user", password: "ptp-pass" }
      });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({ authenticated: true, username: "ptp-user" });
      const cookie = login.cookies.find((item) => item.name === "popcorn_session");
      expect(cookie?.value).toBeTruthy();
      expect(cookie?.httpOnly).toBe(true);

      const session = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { popcorn_session: cookie!.value }
      });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({ authRequired: true, authenticated: true, username: "ptp-user" });

      const jobs = await app.inject({
        method: "GET",
        url: "/api/jobs",
        cookies: { popcorn_session: cookie!.value }
      });
      expect(jobs.statusCode).toBe(200);

      const browserCheck = await app.inject({
        method: "POST",
        url: "/api/browser/cache/invalidate",
        headers: authHeaders,
        payload: { title: "Movie.2024.1080p.WEB-DL.x265-GROUP", imdbId: "tt1234567" }
      });
      expect(browserCheck.statusCode).toBe(200);

      const logout = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        cookies: { popcorn_session: cookie!.value }
      });
      expect(logout.statusCode).toBe(200);

      const afterLogout = await app.inject({
        method: "GET",
        url: "/api/jobs",
        cookies: { popcorn_session: cookie!.value }
      });
      expect(afterLogout.statusCode).toBe(401);
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

  it("returns null download status for jobs without a download snapshot", async () => {
    await withServer(async (app) => {
      const create = await app.inject({
        method: "POST",
        url: "/api/jobs",
        payload: {
          site: "unknown",
          title: "Movie.2024.1080p.WEB-DL.x265-GROUP",
          imdbId: "tt1234567"
        }
      });
      expect(create.statusCode).toBe(201);
      const job = create.json<{ job: Job }>().job;

      const response = await app.inject({ method: "GET", url: `/api/jobs/${job.id}/download-status` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ downloadStatus: null });
    });
  });

  it("resumes paused jobs through the API", async () => {
    await withServer(async (app) => {
      const create = await app.inject({
        method: "POST",
        url: "/api/jobs",
        payload: {
          site: "unknown",
          title: "Movie.2024.1080p.WEB-DL.x265-GROUP",
          imdbId: "tt1234567"
        }
      });
      expect(create.statusCode).toBe(201);
      const job = create.json<{ job: Job }>().job;

      const pause = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/pause` });
      expect(pause.statusCode).toBe(200);
      expect(pause.json<{ job: Job }>().job.state).toBe("paused");

      const resume = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/resume` });
      expect(resume.statusCode).toBe(200);
      expect(resume.json<{ job: Job }>().job).toMatchObject({
        state: "preparing",
        phase: "intake",
        humanStep: "Preparing upload package"
      });
    });
  });

  it("creates browser upload jobs from multipart submissions", async () => {
    await rm(testConfig().paths.dataRoot, { recursive: true, force: true });
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
      expect(job.torrent?.filePath).toMatch(/torrent[/\\]source\.torrent$/);
      expect(job.workspace?.jobRoot).toContain(job.id);
      await expect(access(job.torrent!.filePath!)).resolves.toBeUndefined();
      expect(job.state).toBe("preparing");
      expect(job.uploadPlan.screenshots.imageHosts[0]).toBe("imgbb");
      expect(job.uploadPlan.reviewGates).toContainEqual(expect.objectContaining({ id: "duplicate:slot-full", severity: "blocker" }));
    });
  });

  it("uses intent action routes for upload starts and keeps only skip debug routing", async () => {
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

      const legacyDebugAdvance = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/debug/advance` });
      expect(legacyDebugAdvance.statusCode).toBe(404);
      const legacyAdvance = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/advance` });
      expect(legacyAdvance.statusCode).toBe(404);
      const legacyForceState = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/debug/force-state` });
      expect(legacyForceState.statusCode).toBe(404);

      const blocked = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/debug/skip` });
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
      expect(job.state).toBe("review");
      expect(job.events.at(0)?.message).toBe("Retry is only available for failed jobs.");
    });
  });

  it("retries completed evidence phases without rerunning unrelated completed phases", async () => {
    const { JobRepository } = await import("./jobs.js");
    const repo = new JobRepository();
    let seeded = repo.markPreparedForReview(
      repo.create({
        candidate: {
          site: "mteam",
          title: "Movie.2024.1080p.WEB-DL.x265.HDR-GROUP",
          imdbId: "tt1234567"
        }
      }).id,
      {
        uploadReadiness: "ready",
        artifacts: {
          mediaFiles: ["media/upload/movie.mkv"],
          screenshots: ["https://imgbb.test/1.png", "https://imgbb.test/2.png"],
          mediaInfoText: "General\nComplete name : movie.mkv\n",
          mediainfo: "General\nComplete name : movie.mkv\n",
          uploadTorrent: "torrent/upload.torrent"
        }
      }
    )!;
    seeded.phases = seeded.phases.map((phase) => ({ ...phase, state: "done" as const, message: "Done." }));
    persistenceState.initialJobs = [seeded];

    await withServer(async (app) => {
      const response = await app.inject({ method: "POST", url: `/api/jobs/${seeded.id}/phases/inspect-media/retry` });
      expect(response.statusCode).toBe(200);
      const job = response.json<{ job: Job }>().job;

      expect(job.state).toBe("review");
      expect(job.phase).toBe("review");
      expect(job.artifacts.screenshots).toEqual(["https://imgbb.test/1.png", "https://imgbb.test/2.png"]);
      expect(job.artifacts.mediaInfoText).toContain("Complete name");
      expect(job.phases.find((phase) => phase.phase === "inspect-media")).toMatchObject({
        state: "done",
        retryCount: 1,
        message: "Media analysis plan prepared."
      });
      expect(job.phases.find((phase) => phase.phase === "screenshots")).toMatchObject({
        state: "done",
        retryCount: 0,
        message: "Done."
      });

      const unsafe = await app.inject({ method: "POST", url: `/api/jobs/${seeded.id}/phases/upload/retry` });
      expect(unsafe.statusCode).toBe(400);
      expect(unsafe.json()).toEqual({ error: "phase_retry_not_available" });
    });
  });

  it("automatically prepares created jobs to review when enabled", async () => {
    await withServer(
      async (app) => {
        const create = await app.inject({
          method: "POST",
          url: "/api/jobs",
          payload: {
            site: "mteam",
            title: "Movie.2024.1080p.BluRay.x264-GROUP",
            imdbId: "tt1234567"
          }
        });
        expect(create.statusCode).toBe(201);
        const created = create.json<{ job: Job }>().job;

        const prepared = await waitForJob(app, created.id, (job) => job.state === "review");

        expect(prepared.phase).toBe("review");
        expect(prepared.uploadReadiness).toBe("missing_evidence");
        expect(prepared.events.some((event) => event.message === "Upload package ready for review.")).toBe(true);

        const logs = await app.inject({ method: "GET", url: `/api/jobs/${created.id}/logs` });
        expect(logs.statusCode).toBe(200);
        expect(logs.json<{ lines: string[] }>().lines.join("\n")).toContain("Starting phase.");
      },
      { autoPrepare: true }
    );
  });

  it("resumes persisted preparing jobs after API restart", async () => {
    const { JobRepository } = await import("./jobs.js");
    const persisted = new JobRepository().create({
      candidate: {
        site: "mteam",
        title: "Restarted.Movie.2024.1080p.WEB-DL.x265-GROUP",
        imdbId: "tt1234567"
      }
    });
    persistenceState.initialJobs = [persisted];

    await withServer(
      async (app) => {
        const resumed = await waitForJob(app, persisted.id, (job) => job.state === "review");

        expect(resumed.phase).toBe("review");
        expect(resumed.events.some((event) => event.message === "Resuming preparation after API startup.")).toBe(true);
      },
      { autoPrepare: true }
    );
  });

  it("imports a copied done job and marks it for reseed when qBittorrent is missing it", async () => {
    const jobPath = await mkdtemp(path.join(os.tmpdir(), "popcorn-restored-job-"));
    await mkdir(path.join(jobPath, "media", "upload"), { recursive: true });
    await mkdir(path.join(jobPath, "torrent"), { recursive: true });
    await writeFile(path.join(jobPath, "media", "upload", "Restored.Movie.2024.1080p.BluRay.x264-GROUP.mkv"), "mkv");
    await writeFile(path.join(jobPath, "torrent", "upload.torrent"), "torrent");

    await withServer(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/jobs/import",
        payload: {
          jobPath,
          manifest: {
            version: 1,
            jobId: "restored-job",
            createdAt: "2026-05-08T00:00:00.000Z",
            state: "done",
            source: { title: "Restored.Movie.2024.1080p.BluRay.x264-GROUP" },
            uploadFiles: ["media/upload/Restored.Movie.2024.1080p.BluRay.x264-GROUP.mkv"],
            torrentFile: "torrent/upload.torrent",
            sourceRef: { sourceId: "source-1", originalDownloadPresent: false }
          }
        }
      });

      expect(response.statusCode).toBe(201);
      expect(response.json<{ job: Job }>().job.state).toBe("needs_reseed");
    });
  });

  it("retries needs-reseed jobs by handing the upload torrent to qBittorrent", async () => {
    const jobPath = await mkdtemp(path.join(os.tmpdir(), "popcorn-retry-reseed-job-"));
    const torrentPath = path.join(jobPath, "torrent", "upload.torrent");
    await mkdir(path.join(jobPath, "media", "upload"), { recursive: true });
    await mkdir(path.dirname(torrentPath), { recursive: true });
    await writeFile(path.join(jobPath, "media", "upload", "Restored.Movie.2024.1080p.BluRay.x264-GROUP.mkv"), "mkv");
    await writeFile(torrentPath, "torrent");
    const addCalls: Array<{ torrentPath: string; downloadPath: string; skipHashCheck?: boolean }> = [];

    await withServer(
      async (app) => {
        const imported = await app.inject({
          method: "POST",
          url: "/api/jobs/import",
          payload: {
            jobPath,
            manifest: {
              version: 1,
              jobId: "needs-reseed-job",
              createdAt: "2026-05-08T00:00:00.000Z",
              state: "done",
              source: { title: "Restored.Movie.2024.1080p.BluRay.x264-GROUP" },
              uploadFiles: ["media/upload/Restored.Movie.2024.1080p.BluRay.x264-GROUP.mkv"],
              torrentFile: "torrent/upload.torrent",
              sourceRef: { sourceId: "source-1", originalDownloadPresent: false }
            }
          }
        });
        expect(imported.statusCode).toBe(201);
        expect(imported.json<{ job: Job }>().job.state).toBe("needs_reseed");

        const retry = await app.inject({ method: "POST", url: "/api/jobs/needs-reseed-job/retry-failed" });
        expect(retry.statusCode).toBe(200);
        const job = retry.json<{ job: Job }>().job;

        expect(job.state).toBe("seeding");
        expect(job.phase).toBe("done");
        expect(job.phases.find((phase) => phase.phase === "post-hook")).toMatchObject({ state: "done" });
        expect(addCalls).toEqual([
          {
            torrentPath,
            downloadPath: path.join(jobPath, "media", "upload"),
            skipHashCheck: true
          }
        ]);
      },
      {
        autoPrepare: false,
        torrentClient: {
          name: "mock-qb",
          async addTorrent(options) {
            addCalls.push(options);
            return { infoHash: "ABC123" };
          },
          async getStatus() {
            throw new Error("getStatus should not run during retry reseed.");
          },
          async isComplete() {
            return true;
          },
          async listFiles() {
            return [];
          }
        }
      }
    );
  });

  it("keeps restored done jobs in review when required upload files are missing", async () => {
    const jobPath = await mkdtemp(path.join(os.tmpdir(), "popcorn-missing-restored-job-"));
    await withServer(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/jobs/import",
        payload: {
          jobPath,
          manifest: {
            version: 1,
            jobId: "missing-restored-job",
            createdAt: "2026-05-08T00:00:00.000Z",
            state: "done",
            source: { title: "Missing.Movie.2024.1080p.BluRay.x264-GROUP" },
            uploadFiles: ["media/upload/Missing.Movie.2024.1080p.BluRay.x264-GROUP.mkv"],
            torrentFile: "torrent/upload.torrent",
            sourceRef: { sourceId: "source-1", originalDownloadPresent: false }
          }
        }
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(job.state).toBe("review");
      expect(job.uploadReadiness).toBe("missing_evidence");
      expect(job.events.at(0)?.message).toBe("Restored job is missing upload files.");
    });
  });

  it("patches the review draft, runs Start Upload, and hands the upload torrent to qBittorrent", async () => {
    const jobPath = await mkdtemp(path.join(os.tmpdir(), "popcorn-upload-job-"));
    const torrentPath = path.join(jobPath, "torrent", "upload.torrent");
    await mkdir(path.join(jobPath, "media", "upload"), { recursive: true });
    await mkdir(path.dirname(torrentPath), { recursive: true });
    await writeFile(path.join(jobPath, "media", "upload", "Upload.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv"), "mkv");
    await writeFile(torrentPath, "torrent");
    const submitted: Array<{ torrentPath: string; description: string; groupId: string | null }> = [];
    const addCalls: Array<{ torrentPath: string; downloadPath: string; tags?: string[]; skipHashCheck?: boolean }> = [];

    await withServer(
      async (app) => {
        const imported = await app.inject({
          method: "POST",
          url: "/api/jobs/import",
          payload: {
            jobPath,
            manifest: {
              version: 1,
              jobId: "upload-restored-job",
              createdAt: "2026-05-08T00:00:00.000Z",
              state: "review",
              source: { title: "Upload.Movie.2024.1080p.WEB-DL.x265-GROUP" },
              uploadFiles: ["media/upload/Upload.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv"],
              torrentFile: "torrent/upload.torrent",
              sourceRef: { sourceId: "source-1", originalDownloadPresent: false }
            }
          }
        });
        expect(imported.statusCode).toBe(201);
        let job = imported.json<{ job: Job }>().job;
        expect(job.reviewDraft?.releaseName).toContain("Upload.Movie");

        const patch = await app.inject({
          method: "PATCH",
          url: `/api/jobs/${job.id}/review-draft`,
          payload: {
            description: "Edited release description",
            groupId: "123"
          }
        });
        expect(patch.statusCode).toBe(200);
        job = patch.json<{ job: Job }>().job;
        expect(job.reviewDraft).toMatchObject({ description: "Edited release description", groupId: "123" });

        const start = await app.inject({ method: "POST", url: `/api/jobs/${job.id}/start-upload` });
        expect(start.statusCode).toBe(200);
        job = start.json<{ job: Job }>().job;
        expect(job.state).toBe("done");
        expect(job.humanStep).toBe("Complete");
        expect(job.artifacts).toMatchObject({
          ptpUrl: "https://passthepopcorn.me/torrents.php?id=123&torrentid=456",
          ptpGroupId: "123",
          ptpTorrentId: "456"
        });
        expect(job.phases.find((phase) => phase.phase === "post-hook")).toMatchObject({ state: "done" });
        expect(submitted).toEqual([{ torrentPath, description: "Edited release description", groupId: "123" }]);
        expect(addCalls).toEqual([
          {
            torrentPath,
            downloadPath: path.join(jobPath, "media", "upload"),
            skipHashCheck: true
          }
        ]);
        const uploadTorrent = (await readFile(torrentPath)).toString("binary");
        expect(uploadTorrent).toContain("https://please.passthepopcorn.me/passkey/announce");
        expect(uploadTorrent).toContain("Upload.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
        expect(uploadTorrent).not.toContain("torrent");
      },
      {
        autoPrepare: false,
        torrentClient: {
          name: "mock-qb",
          async addTorrent(options) {
            addCalls.push(options);
            return { infoHash: "ABC123" };
          },
          async getStatus() {
            throw new Error("getStatus should not run during upload handoff.");
          },
          async isComplete() {
            return true;
          },
          async listFiles() {
            return [];
          }
        },
        ptpSubmitter: {
          async submit(input) {
            submitted.push({ torrentPath: input.torrentPath, description: input.draft.description, groupId: input.draft.groupId });
            return {
              groupId: "123",
              torrentId: "456",
              ptpUrl: "https://passthepopcorn.me/torrents.php?id=123&torrentid=456"
            };
          }
        }
      }
    );
  });

  it("validates manual intake media paths from arbitrary absolute locations", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-media-root-"));
    const movie = path.join(root, "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.mkv");
    await writeFile(movie, "movie");
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), "popcorn-anywhere-media-"));
    const otherMovie = path.join(otherRoot, "Anywhere.Movie.2024.1080p.WEB-DL.x265-GROUP.mp4");
    await writeFile(otherMovie, "movie");

    await withConfiguredServer(testConfig(), { autoPrepare: false }, async (app) => {
      const ok = await app.inject({
        method: "POST",
        url: "/api/intake/media-path/validate",
        payload: { mediaPath: movie }
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, basename: path.basename(movie), kind: "file", error: null });

      const anywhere = await app.inject({
        method: "POST",
        url: "/api/intake/media-path/validate",
        payload: { mediaPath: otherMovie }
      });
      expect(anywhere.statusCode).toBe(200);
      expect(anywhere.json()).toMatchObject({ ok: true, basename: path.basename(otherMovie), kind: "file", error: null });
    });
  });

  it("accepts directory media paths with a warning", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-media-directory-"));
    await writeFile(path.join(root, "Directory.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv"), "movie");

    await withConfiguredServer(testConfig(), { autoPrepare: false }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/media-path/validate",
        payload: { mediaPath: root }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        mediaPath: root,
        basename: path.basename(root),
        kind: "directory",
        size: null,
        error: null,
        warning: "media_path_is_directory"
      });
    });
  });

  it("searches PTP movies from a manual release name without creating a job", async () => {
    const search = vi.spyOn(PtpClient.prototype, "searchByCandidate").mockResolvedValue({
      totalResults: 1,
      movies: [
        {
          GroupId: "205678",
          Title: "Skaz pro to, kak tsar Pyotr arapa zhenil",
          Name: "How Czar Peter the Great Married Off His Moor",
          Year: "1976",
          ImdbId: "tt0075169",
          Torrents: []
        }
      ]
    });

    await withServer(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/ptp-search",
        payload: { title: "Skaz.pro.to.kak.tsar.Pyotr.arapa.zhenil.1976.1080p.WEB-DL.x265-GROUP" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        query: "Skaz pro to kak tsar Pyotr arapa zhenil",
        parsedYear: "1976",
        results: [
          {
            groupId: "205678",
            displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
          }
        ]
      });
      expect(search).toHaveBeenCalledTimes(1);
    });
  });

  it("resolves a manual PTP target from a PTP movie URL", async () => {
    const getGroup = vi.spyOn(PtpClient.prototype, "getGroup").mockResolvedValue({
      totalResults: 1,
      movies: [
        {
          GroupId: "205678",
          Title: "Skaz pro to, kak tsar Pyotr arapa zhenil",
          Name: "How Czar Peter the Great Married Off His Moor",
          Year: "1976",
          ImdbId: "tt0075169",
          Torrents: []
        }
      ]
    });

    await withServer(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/ptp-target/resolve",
        payload: { ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678&torrentid=1515743" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        target: {
          groupId: "205678",
          displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
          imdbId: "tt0075169",
          ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
        }
      });
      expect(getGroup).toHaveBeenCalledWith("205678");
    });
  });

  it("resolves a manual PTP target from an IMDb URL", async () => {
    const searchByImdb = vi.spyOn(PtpClient.prototype, "searchByImdb").mockResolvedValue({
      totalResults: 1,
      movies: [
        {
          GroupId: "205678",
          Title: "Skaz pro to, kak tsar Pyotr arapa zhenil",
          Name: "How Czar Peter the Great Married Off His Moor",
          Year: "1976",
          ImdbId: "tt0075169",
          Torrents: []
        }
      ]
    });

    await withServer(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/ptp-target/resolve",
        payload: { imdbUrl: "https://www.imdb.com/title/tt0075169/" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        target: {
          groupId: "205678",
          displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
          imdbId: "tt0075169",
          ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
        }
      });
      expect(searchByImdb).toHaveBeenCalledWith("tt0075169");
    });
  });

  it("creates manual intake jobs from server media and uploaded torrent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-upload-"));
    const mediaPath = path.join(root, "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await writeFile(mediaPath, "movie");
    const config = testConfig();
    const boundary = "popcorn-manual-intake-upload";

    await withConfiguredServer(config, { autoPrepare: false }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipartBody(
          boundary,
          {
            mediaPath,
            releaseName: "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP",
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
            filename: "Manual.Movie.source.torrent",
            contentType: "application/x-bittorrent",
            value: "d4:infod6:lengthi1eee"
          }
        )
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(job.source).toMatchObject({
        site: "unknown",
        title: "Manual.Movie.2024.1080p.WEB-DL.x265-GROUP",
        mediaPath,
        ptpTarget: { groupId: "205678", ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678" }
      });
      expect(job.reviewDraft).toMatchObject({ groupId: "205678", imdb: "tt1234567" });
      expect(job.torrent).toMatchObject({ filename: "Manual.Movie.source.torrent" });
      await expect(access(job.torrent!.filePath!)).resolves.toBeUndefined();
    });
  });

  it("runs duplicate checks for manual intake jobs against the confirmed PTP group", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-manual-duplicate-"));
    const mediaPath = path.join(root, "Manual.Movie.2024.1080p.WEB-DL.x265.HDR-GROUP.mkv");
    await writeFile(mediaPath, "movie");
    const getGroup = vi.spyOn(PtpClient.prototype, "getGroup").mockResolvedValue({
      totalResults: 1,
      movies: [
        {
          GroupId: "205678",
          Title: "Manual Movie",
          Name: "Manual Movie",
          Year: "2024",
          ImdbId: "tt1234567",
          Torrents: [
            {
              Id: "1",
              Quality: "High Definition",
              Source: "WEB",
              Codec: "H.265",
              Resolution: "1080p",
              Size: "1000",
              Seeders: "1",
              ReleaseName: "Manual.Movie.2024.1080p.WEB-DL.H265.HDR-EXISTING"
            }
          ]
        }
      ]
    });
    const config = testConfig();

    await withConfiguredServer(config, { autoPrepare: false }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          mediaPath,
          releaseName: "Manual.Movie.2024.1080p.WEB-DL.x265.HDR-GROUP",
          ptpTarget: {
            groupId: "205678",
            displayTitle: "Manual Movie [2024]",
            year: "2024",
            imdbId: "tt1234567",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
          }
        }
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(getGroup).toHaveBeenCalledWith("205678");
      expect(job.checkResult?.decision).toMatchObject({
        status: "full",
        reason: "1080p HDR x265 is full."
      });
      expect(job.uploadPlan.reviewGates).toContainEqual(
        expect.objectContaining({
          id: "duplicate:slot-full",
          severity: "blocker",
          status: "open"
        })
      );
      expect(job.uploadPlan.reviewGates).not.toContainEqual(
        expect.objectContaining({
          detail: "Manual PTP target confirmed."
        })
      );
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

  it("creates manual intake jobs from server media without a source torrent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-media-only-"));
    const mediaPath = path.join(root, "Media.Only.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await writeFile(mediaPath, "movie");
    const config = testConfig();

    await withConfiguredServer(config, { autoPrepare: false }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          mediaPath,
          releaseName: "Media.Only.2024.1080p.WEB-DL.x265-GROUP",
          ptpTarget: {
            groupId: "205678",
            displayTitle: "Media Only [2024]",
            year: "2024",
            imdbId: "tt1234567",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
          }
        }
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(job.source).toMatchObject({ mediaPath, ptpTarget: { groupId: "205678" } });
      expect(job.torrent).toBeUndefined();
    });
  });

  it("creates manual intake jobs from a torrent URL without real network", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-url-"));
    const mediaPath = path.join(root, "Url.Movie.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await writeFile(mediaPath, "movie");
    const config = testConfig();
    const fetchImpl: typeof fetch = async () =>
      new Response("d4:infod6:lengthi1eee", {
        status: 200,
        headers: { "content-type": "application/x-bittorrent", "content-disposition": 'attachment; filename="Url.Movie.source.torrent"' }
      });

    await withConfiguredServer(config, { autoPrepare: false, fetchImpl }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          mediaPath,
          releaseName: "Url.Movie.2024.1080p.WEB-DL.x265-GROUP",
          torrentUrl: "https://tracker.example/download/1.torrent",
          ptpTarget: {
            groupId: "300",
            displayTitle: "Url Movie [2024]",
            year: "2024",
            imdbId: "tt7654321",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=300"
          }
        }
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(job.source).toMatchObject({ mediaPath, torrentUrl: "https://tracker.example/download/1.torrent" });
      expect(job.torrent).toMatchObject({ filename: "Url.Movie.source.torrent", contentType: "application/x-bittorrent" });
    });
  });

  it("creates manual intake jobs from a torrent URL without a server media path", async () => {
    const config = testConfig();
    const fetchImpl: typeof fetch = async () =>
      new Response("d4:infod6:lengthi1eee", {
        status: 200,
        headers: { "content-type": "application/x-bittorrent", "content-disposition": 'attachment; filename="Torrent.Only.source.torrent"' }
      });

    await withConfiguredServer(config, { autoPrepare: false, fetchImpl }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          releaseName: "Torrent.Only.2024.1080p.WEB-DL.x265-GROUP",
          torrentUrl: "https://tracker.example/download/2.torrent",
          ptpTarget: {
            groupId: "301",
            displayTitle: "Torrent Only [2024]",
            year: "2024",
            imdbId: "tt7654322",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=301"
          }
        }
      });

      expect(response.statusCode).toBe(201);
      const job = response.json<{ job: Job }>().job;
      expect(job.source).toMatchObject({ torrentUrl: "https://tracker.example/download/2.torrent", ptpTarget: { groupId: "301" } });
      expect(job.source.mediaPath).toBeUndefined();
      expect(job.torrent).toMatchObject({ filename: "Torrent.Only.source.torrent", contentType: "application/x-bittorrent" });
    });
  });

  it("derives manual intake release names when no override is supplied", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "popcorn-intake-derived-release-"));
    const mediaPath = path.join(root, "Derived.Media.2024.1080p.WEB-DL.x265-GROUP.mkv");
    await writeFile(mediaPath, "movie");
    const config = testConfig();
    const fetchImpl: typeof fetch = async () =>
      new Response("d4:infod6:lengthi1eee", {
        status: 200,
        headers: { "content-type": "application/x-bittorrent", "content-disposition": 'attachment; filename="Derived.Torrent.2025.1080p.WEB-DL.x265-GROUP.torrent"' }
      });

    await withConfiguredServer(config, { autoPrepare: false, fetchImpl }, async (app) => {
      const mediaResponse = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          mediaPath,
          ptpTarget: {
            groupId: "401",
            displayTitle: "Derived Media [2024]",
            year: "2024",
            imdbId: "tt1111111",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=401"
          }
        }
      });
      expect(mediaResponse.statusCode).toBe(201);
      expect(mediaResponse.json<{ job: Job }>().job.source.title).toBe("Derived.Media.2024.1080p.WEB-DL.x265-GROUP");

      const torrentResponse = await app.inject({
        method: "POST",
        url: "/api/intake/jobs",
        payload: {
          torrentUrl: "https://tracker.example/download/derived.torrent",
          ptpTarget: {
            groupId: "402",
            displayTitle: "Derived Torrent [2025]",
            year: "2025",
            imdbId: "tt2222222",
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=402"
          }
        }
      });
      expect(torrentResponse.statusCode).toBe(201);
      expect(torrentResponse.json<{ job: Job }>().job.source.title).toBe("Derived.Torrent.2025.1080p.WEB-DL.x265-GROUP");
    });
  });
});
