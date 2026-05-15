import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PtpClient } from "@popcorn-queue/integrations";
import { buildServer } from "./server.js";
import type { ApiConfig } from "./config.js";
import type { BrowserCheckResult, TorrentCandidate } from "@popcorn-queue/core";
import type { CommandExecutor } from "@popcorn-queue/worker";
import { JobRepository, type Job } from "./jobs.js";

const hoistedState = vi.hoisted(() => ({
  initialJobs: [] as Job[]
}));

export const persistenceState = hoistedState;

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

export const authHeaders = { authorization: "Bearer test-browser-token" };

export function testConfig(): ApiConfig {
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
      mpvBin: "mpv",
      oxipngBin: "oxipng",
      xvfbRunBin: "xvfb-run",
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

export async function withServer<T>(run: (app: ReturnType<typeof buildServer>) => Promise<T>, options: Parameters<typeof buildServer>[1] = { autoPrepare: false }): Promise<T> {
  const app = buildServer(testConfig(), options);
  try {
    await app.ready();
    return await run(app);
  } finally {
    await app.close();
  }
}

export async function withConfiguredServer<T>(config: ApiConfig, options: Parameters<typeof buildServer>[1], run: (app: ReturnType<typeof buildServer>) => Promise<T>): Promise<T> {
  const app = buildServer(config, options);
  try {
    await app.ready();
    return await run(app);
  } finally {
    await app.close();
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function waitForJob(app: ReturnType<typeof buildServer>, id: string, predicate: (job: Job) => boolean): Promise<Job> {
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

export function multipartBody(boundary: string, fields: Record<string, string>, file: { name: string; filename: string; contentType: string; value: string }): Buffer {
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
