import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrismaPersistence } from "./persistence.js";

const candidate = {
  site: "mteam" as const,
  title: "Movie.2024.1080p.BluRay.x264-GROUP",
  imdbId: "tt1234567"
};

let previousDatabaseUrl: string | undefined;

afterEach(() => {
  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

describe("Prisma job persistence", () => {
  it("persists download status snapshots", async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "popcorn-prisma-status-"));
    process.env.DATABASE_URL = `file:${path.join(dataDir, "jobs.db")}`;
    const persistence = new PrismaPersistence();
    try {
      const job = await persistence.jobs.create({ candidate });
      await persistence.jobs.updateDownloadStatus(job.id, {
        client: "qbittorrent",
        infoHash: "ABC123",
        state: "downloading",
        progress: 0.42,
        downloaded: 4_200,
        size: 10_000,
        amountLeft: 5_800,
        downloadSpeed: 8_388_608,
        uploadSpeed: 0,
        eta: 720,
        seeds: 12,
        peers: 3,
        savePath: "/downloads",
        contentPath: "/downloads/Movie.mkv",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        error: null
      });

      const loaded = await persistence.jobs.get(job.id);
      expect(loaded?.downloadStatus).toMatchObject({
        client: "qbittorrent",
        infoHash: "ABC123",
        state: "downloading",
        progress: 0.42
      });
    } finally {
      await persistence.disconnect();
    }
  });
});
