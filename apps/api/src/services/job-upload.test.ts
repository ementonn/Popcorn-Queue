import { describe, expect, it, vi } from "vitest";
import { MemoryCacheStore } from "@popcorn-queue/core";
import { JobRepository } from "../jobs.js";
import { testConfig } from "../server-test-utils.js";
import { retryFailedJob, type JobActionContext } from "./job-upload.js";

describe("job upload actions", () => {
  it("enqueues preparation when retrying a failed preparation phase", async () => {
    const jobs = new JobRepository();
    const job = jobs.create({
      candidate: {
        site: "mteam",
        title: "Movie.2024.1080p.WEB-DL.x264-GROUP",
        imdbId: "tt1234567"
      }
    });
    job.state = "failed";
    job.phase = "image-host-upload";
    job.humanStep = "Preparation failed";
    const failedPhase = job.phases.find((phase) => phase.phase === "image-host-upload");
    if (!failedPhase) throw new Error("Missing image-host-upload phase");
    failedPhase.state = "failed";
    failedPhase.message = "Image host upload failed.";

    const enqueuePreparation = vi.fn();
    const context = {
      config: testConfig,
      jobs,
      cache: new MemoryCacheStore(),
      getTorrentClient: () => null,
      getPtpSubmitter: () => undefined,
      getPreparation: () => {
        throw new Error("Preparation service should not be used for failed-job retry.");
      },
      enqueuePreparation
    } as unknown as JobActionContext;

    const retried = await retryFailedJob(context, job.id);

    expect(retried?.state).toBe("preparing");
    expect(enqueuePreparation).toHaveBeenCalledWith(job.id);
  });
});
