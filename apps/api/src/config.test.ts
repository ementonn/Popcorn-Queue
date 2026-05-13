import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadEnvFile } from "./config.js";

describe("API configuration", () => {
  it("loads dotenv files without overriding explicit environment values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "popcorn-queue-env-"));
    const envFile = join(directory, ".env");
    const env: Record<string, string | undefined> = {
      POPCORN_QUEUE_BROWSER_TOKEN: "already-set"
    };

    try {
      await writeFile(
        envFile,
        [
          "POPCORN_QUEUE_PORT=3510",
          "POPCORN_QUEUE_PUBLIC_HOST=example.com",
          "POPCORN_QUEUE_WEB_PORT=5173",
          "POPCORN_QUEUE_BROWSER_TOKEN=from-file",
          "PTP_BASE_URL=https://example.test/torrents.php",
          "POPCORN_QUEUE_RUN_EXTERNAL_TOOLS=true"
        ].join("\n")
      );

      expect(loadEnvFile(envFile, env)).toBe(true);
      expect(env.POPCORN_QUEUE_PORT).toBe("3510");
      expect(env.POPCORN_QUEUE_BROWSER_TOKEN).toBe("already-set");
      expect(env.PTP_BASE_URL).toBe("https://example.test/torrents.php");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("can let local dotenv values override stale process-level values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "popcorn-queue-env-"));
    const envFile = join(directory, ".env");
    const env: Record<string, string | undefined> = {
      POPCORN_QUEUE_BROWSER_TOKEN: "old-token"
    };

    try {
      await writeFile(envFile, "POPCORN_QUEUE_BROWSER_TOKEN=new-token\n");

      expect(loadEnvFile(envFile, env, { override: true })).toBe(true);
      expect(env.POPCORN_QUEUE_BROWSER_TOKEN).toBe("new-token");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enables external tools by default", () => {
    expect(loadConfig({}).integrations.runExternalTools).toBe(true);
  });

  it("maps runnable service settings from environment variables", () => {
    const config = loadConfig({
      POPCORN_QUEUE_HOST: "0.0.0.0",
      POPCORN_QUEUE_PORT: "3510",
      POPCORN_QUEUE_PUBLIC_SCHEME: "https",
      POPCORN_QUEUE_PUBLIC_HOST: "queue.example.test",
      POPCORN_QUEUE_WEB_PORT: "5174",
      POPCORN_QUEUE_WEB_AUTH: "true",
      POPCORN_QUEUE_WEB_AUTH_COOKIE: "custom_session",
      POPCORN_QUEUE_WEB_AUTH_MAX_AGE_SECONDS: "120",
      POPCORN_QUEUE_BROWSER_TOKEN: "test-token",
      PTP_API_USER: "ptp-user",
      PTP_API_KEY: "ptp-key",
      PTP_USERNAME: "ptp-username",
      PTP_PASSWORD: "ptp-password",
      PTP_BASE_URL: "https://example.test/torrents.php",
      PTP_USER_AGENT: "Popcorn Queue Test",
      PTP_REQUEST_DELAY_MS: "0",
      PTP_ANNOUNCE_URL: "https://tracker.example/announce",
      PTP_COOKIE_FILE: "/tmp/ptp.cookie",
      POPCORN_QUEUE_IMAGE_HOST: "imgbb",
      IMGBB_API_KEY: "imgbb-key",
      TMDB_API_KEY: "tmdb-key",
      PTPIMG_API_KEY: "ptpimg-key",
      QBITTORRENT_URL: "http://127.0.0.1:8080",
      QBITTORRENT_USERNAME: "qb-user",
      QBITTORRENT_PASSWORD: "qb-pass",
      QBITTORRENT_TAGS: "ptp,upload",
      QBITTORRENT_CATEGORY: "movies",
      QBITTORRENT_CONTENT_LAYOUT: "Original",
      QBITTORRENT_DOWNLOAD_WAIT_MS: "1234",
      QBITTORRENT_DOWNLOAD_POLL_MS: "56",
      POPCORN_QUEUE_RUN_EXTERNAL_TOOLS: "true",
      POPCORN_QUEUE_DATA_ROOT: "/tmp/data-root",
      FFMPEG_BIN: "/usr/bin/ffmpeg",
      MEDIAINFO_BIN: "/usr/bin/mediainfo",
      MKVMERGE_BIN: "/usr/bin/mkvmerge",
      MPV_BIN: "/usr/bin/mpv",
      OXIPNG_BIN: "/usr/bin/oxipng",
      XVFB_RUN_BIN: "/usr/bin/xvfb-run",
      POPCORN_QUEUE_WORK_DIR: "/tmp/work",
      POPCORN_QUEUE_OUTPUT_DIR: "/tmp/output",
      POPCORN_QUEUE_LOG_LEVEL: "debug",
      POPCORN_QUEUE_LOG_FILE: "logs/api-test.log",
      POPCORN_QUEUE_WORKER_LOG_FILE: "logs/worker-test.log",
      POPCORN_QUEUE_LOG_TO_FILE: "false",
      POPCORN_QUEUE_LOG_TO_CONSOLE: "false"
    });

    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 3510,
      webAuth: {
        enabled: true,
        sessionCookieName: "custom_session",
        sessionMaxAgeSeconds: 120
      },
      browserToken: "test-token",
      publicWebUrl: "https://queue.example.test:5174",
      publicApiUrl: "https://queue.example.test:3510",
      allowedOrigins: ["https://queue.example.test:5174", "http://localhost:5174", "http://127.0.0.1:5174"],
      ptp: {
        apiUser: "ptp-user",
        apiKey: "ptp-key",
        username: "ptp-username",
        password: "ptp-password",
        baseUrl: "https://example.test/torrents.php",
        userAgent: "Popcorn Queue Test",
        requestDelayMs: 0,
        announceUrl: "https://tracker.example/announce",
        cookieFile: "/tmp/ptp.cookie"
      },
      integrations: {
        imageHost: "imgbb",
        imgbbApiKey: "imgbb-key",
        tmdbApiKey: "tmdb-key",
        ptpImgApiKey: "ptpimg-key",
        qbittorrentUrl: "http://127.0.0.1:8080",
        qbittorrentUsername: "qb-user",
        qbittorrentPassword: "qb-pass",
        qbittorrentTags: ["ptp", "upload"],
        qbittorrentCategory: "movies",
        qbittorrentContentLayout: "Original",
        qbittorrentDownloadWaitMs: 1234,
        qbittorrentDownloadPollMs: 56,
        runExternalTools: true,
        ffmpegBin: "/usr/bin/ffmpeg",
        mediainfoBin: "/usr/bin/mediainfo",
        mkvmergeBin: "/usr/bin/mkvmerge",
        mpvBin: "/usr/bin/mpv",
        oxipngBin: "/usr/bin/oxipng",
        xvfbRunBin: "/usr/bin/xvfb-run",
        workDir: "/tmp/work",
        outputDir: "/tmp/output"
      },
      logging: {
        level: "debug",
        toFile: false,
        toConsole: false
      },
      paths: {
        dataRoot: "/tmp/data-root"
      }
    });
    expect(config.logging.file).toMatch(/logs[/\\]api-test\.log$/);
    expect(config.paths.apiLogFile).toMatch(/logs[/\\]api-test\.log$/);
    expect(config.paths.workerLogFile).toMatch(/logs[/\\]worker-test\.log$/);
  });
});
