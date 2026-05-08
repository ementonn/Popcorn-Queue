import { mkdtemp } from "node:fs/promises";
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
});
