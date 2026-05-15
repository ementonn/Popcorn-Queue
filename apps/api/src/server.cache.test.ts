import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtpClient } from "@popcorn-queue/integrations";
import type { BrowserCheckResult, TorrentCandidate } from "@popcorn-queue/core";
import type { CommandExecutor } from "@popcorn-queue/worker";
import { JobRepository, type Job } from "./jobs.js";
import { authHeaders, multipartBody, pathExists, persistenceState, testConfig, waitForJob, withConfiguredServer, withServer } from "./server-test-utils.js";

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
          mpv: { available: true, version: "mpv version test", location: "/usr/bin/mpv" },
          oxipng: { available: true, version: "oxipng version test", location: "/usr/bin/oxipng" },
          "xvfb-run": { available: true, version: "xvfb-run version test", location: "/usr/bin/xvfb-run" }
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
        expect(keys).toContain("MPV_BIN");
        expect(keys).toContain("XVFB_RUN_BIN");
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
