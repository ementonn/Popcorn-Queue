import { describe, expect, it } from "vitest";
import { JobRepository } from "./jobs.js";
import { normalizeLegacyJobState, normalizeLegacyPhaseState } from "./persistence.js";

const candidate = {
  site: "mteam" as const,
  title: "Movie.2024.1080p.BluRay.x264-GROUP",
  imdbId: "tt1234567"
};

describe("JobRepository pre-upload state machine", () => {
  it("creates jobs in preparing state with human-facing status", () => {
    const repo = new JobRepository();
    const job = repo.create({ candidate });

    expect(job.state).toBe("preparing");
    expect(job.phase).toBe("intake");
    expect(job.uploadReadiness).toBe("missing_evidence");
    expect(job.humanStep).toBe("Preparing upload package");
  });

  it("moves to review when preparation finishes and only starts upload when ready", () => {
    const repo = new JobRepository();
    let job = repo.create({ candidate });

    job = repo.markPreparedForReview(job.id, {
      uploadReadiness: "ready",
      artifacts: {
        mediaFiles: ["media/upload/Movie.2024.1080p.BluRay.x264-GROUP.mkv"],
        screenshots: ["screenshots/hosted.json"],
        mediainfo: "metadata/mediainfo.txt",
        releaseName: "metadata/release-name.txt",
        description: "metadata/description.md",
        uploadTorrent: "torrent/upload.torrent"
      }
    })!;

    expect(job.state).toBe("review");
    expect(job.humanStep).toBe("Review upload package");

    job = repo.startUpload(job.id)!;
    expect(job.state).toBe("uploading");
    expect(job.phase).toBe("upload");
  });

  it("uses compact complete copy when upload finishes", () => {
    const repo = new JobRepository();
    let job = repo.markPreparedForReview(repo.create({ candidate }).id, { uploadReadiness: "ready", artifacts: {} })!;
    job = repo.markUploadResult(job.id, { ptpUrl: "https://passthepopcorn.me/torrents.php?id=1", groupId: "1", torrentId: "2" })!;

    expect(job.state).toBe("done");
    expect(job.humanStep).toBe("Complete");
    expect(job.phases.find((phase) => phase.phase === "done")).toMatchObject({ state: "done", message: "Complete." });
  });

  it("blocks Start Upload when readiness is blocked", () => {
    const repo = new JobRepository();
    let job = repo.create({
      candidate: {
        site: "unknown",
        title: "Movie.2024.1080p.BluRay.x264-YIFY.mp4",
        imdbId: null
      }
    });

    job = repo.markPreparedForReview(job.id, { uploadReadiness: "blocked", artifacts: {} })!;
    const blocked = repo.startUpload(job.id)!;

    expect(blocked.state).toBe("review");
    expect(blocked.events.at(0)?.message).toBe("Cannot start upload until blockers and required evidence are resolved.");
  });

  it("blocks every skip into upload until readiness is ready and blocker gates are resolved", () => {
    const repo = new JobRepository();
    let job = repo.create({ candidate });

    while (job.phase !== "review") {
      job = repo.skip(job.id)!;
    }

    job = repo.skip(job.id)!;
    expect(job.phase).toBe("review");
    expect(job.state).toBe("review");
    expect(job.events.at(0)?.message).toBe("Cannot start upload until blockers and required evidence are resolved.");

    job = repo.markPreparedForReview(job.id, { uploadReadiness: "ready", artifacts: {} })!;
    job = repo.skip(job.id)!;

    expect(job.phase).toBe("upload");
    expect(job.state).toBe("uploading");
  });

  it("blocks Start Upload when stale readiness is ready but blocker gates are open", () => {
    const repo = new JobRepository();
    let job = repo.create({
      candidate: {
        site: "unknown",
        title: "Movie.2024.1080p.BluRay.x264-YIFY.mp4",
        imdbId: null
      }
    });

    job = repo.markPreparedForReview(job.id, { uploadReadiness: "ready", artifacts: {} })!;
    job = repo.startUpload(job.id)!;

    expect(job.state).toBe("review");
    expect(job.phase).toBe("review");
    expect(job.events.at(0)?.message).toBe("Cannot start upload until blockers and required evidence are resolved.");
  });

  it("only retries failed jobs or failed phases", () => {
    const repo = new JobRepository();
    let done = repo.markPreparedForReview(repo.create({ candidate }).id, { uploadReadiness: "ready", artifacts: {} })!;
    done.state = "done";

    done = repo.retryFailed(done.id)!;
    expect(done.state).toBe("done");
    expect(done.events.at(0)?.message).toBe("Retry is only available for failed jobs.");

    let uploading = repo.markPreparedForReview(repo.create({ candidate }).id, { uploadReadiness: "ready", artifacts: {} })!;
    uploading = repo.startUpload(uploading.id)!;
    uploading = repo.retryFailed(uploading.id)!;
    expect(uploading.state).toBe("uploading");
    expect(uploading.events.at(0)?.message).toBe("Retry is only available for failed jobs.");

    let failed = repo.create({ candidate });
    failed.state = "failed";
    failed.phases[0]!.state = "failed";
    failed = repo.retryFailed(failed.id)!;
    expect(failed.state).toBe("preparing");
    expect(failed.phases[0]).toMatchObject({ state: "pending", retryCount: 1, message: "Retry queued." });
  });

  it("resumes paused jobs to their active phase state", () => {
    const repo = new JobRepository();
    let preparing = repo.create({ candidate });

    preparing = repo.pause(preparing.id)!;
    expect(preparing.state).toBe("paused");

    preparing = repo.resume(preparing.id)!;
    expect(preparing.state).toBe("preparing");
    expect(preparing.phase).toBe("intake");
    expect(preparing.humanStep).toBe("Preparing upload package");
    expect(preparing.events.at(0)?.message).toBe("Job resumed.");

    let review = repo.markPreparedForReview(repo.create({ candidate }).id, { uploadReadiness: "ready", artifacts: {} })!;
    review = repo.pause(review.id)!;
    review = repo.resume(review.id)!;

    expect(review.state).toBe("review");
    expect(review.phase).toBe("review");
    expect(review.humanStep).toBe("Review upload package");
  });

  it("stores latest download status without adding noisy job events", () => {
    const repo = new JobRepository();
    let job = repo.create({ candidate });
    const eventCount = job.events.length;

    job = repo.updateDownloadStatus(job.id, {
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
    })!;

    expect(job.downloadStatus).toMatchObject({ infoHash: "ABC123", progress: 0.42 });
    expect(job.events).toHaveLength(eventCount);
  });
});

describe("legacy persisted job normalization", () => {
  it("maps old job states onto durable states", () => {
    expect(normalizeLegacyJobState("waiting", "intake")).toBe("preparing");
    expect(normalizeLegacyJobState("queued", "metadata")).toBe("preparing");
    expect(normalizeLegacyJobState("running", "upload")).toBe("uploading");
    expect(normalizeLegacyJobState("running", "preflight")).toBe("preparing");
  });

  it("maps old phase states onto current phase states", () => {
    expect(normalizeLegacyPhaseState("blocked")).toBe("warning");
    expect(normalizeLegacyPhaseState("running")).toBe("running");
  });
});
