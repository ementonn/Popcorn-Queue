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

  it("keeps uploaded jobs out of Complete when the qBittorrent post-hook fails", () => {
    const repo = new JobRepository();
    let job = repo.markPreparedForReview(repo.create({ candidate }).id, { uploadReadiness: "ready", artifacts: {} })!;
    job = repo.startUpload(job.id)!;

    const phases = job.phases.map((phase) => {
      if (phase.phase === "upload") return { ...phase, state: "done" as const, message: "PTP upload submitted." };
      if (phase.phase === "post-hook") {
        return { ...phase, state: "failed" as const, message: "qBittorrent add torrent failed with HTTP 403." };
      }
      return phase;
    });

    job = repo.markUploadResult(
      job.id,
      { ptpUrl: "https://passthepopcorn.me/torrents.php?id=1&torrentid=2", groupId: "1", torrentId: "2" },
      phases
    )!;

    expect(job.state).toBe("needs_reseed");
    expect(job.phase).toBe("post-hook");
    expect(job.humanStep).toBe("Needs reseed");
    expect(job.artifacts.ptpUrl).toBe("https://passthepopcorn.me/torrents.php?id=1&torrentid=2");
    expect(job.phases.find((phase) => phase.phase === "post-hook")).toMatchObject({
      state: "failed",
      message: "qBittorrent add torrent failed with HTTP 403."
    });
    expect(job.phases.find((phase) => phase.phase === "done")).toMatchObject({ state: "pending" });
  });

  it("repairs legacy complete jobs whose post-hook failed", () => {
    const seedRepo = new JobRepository();
    let legacy = seedRepo.markPreparedForReview(seedRepo.create({ candidate }).id, { uploadReadiness: "ready", artifacts: {} })!;
    legacy = seedRepo.startUpload(legacy.id)!;
    legacy.state = "done";
    legacy.phase = "done";
    legacy.humanStep = "Complete";
    legacy.phases = legacy.phases.map((phase) => {
      if (phase.phase === "upload") return { ...phase, state: "done" as const, message: "PTP upload submitted." };
      if (phase.phase === "post-hook") return { ...phase, state: "failed" as const, message: "qBittorrent add torrent failed with HTTP 403." };
      if (phase.phase === "done") return { ...phase, state: "done" as const, message: "Complete." };
      return phase;
    });

    const repo = new JobRepository([legacy]);
    const repaired = repo.get(legacy.id)!;

    expect(repaired.state).toBe("needs_reseed");
    expect(repaired.phase).toBe("post-hook");
    expect(repaired.humanStep).toBe("Needs reseed");
    expect(repaired.phases.find((phase) => phase.phase === "done")).toMatchObject({ state: "pending" });
  });

  it("adds newly introduced phases to legacy job phase lists", () => {
    const seedRepo = new JobRepository();
    const legacy = seedRepo.create({ candidate });
    legacy.phases = legacy.phases.filter((phase) => phase.phase !== "sync-ptp-cache");

    const repaired = new JobRepository([legacy]).get(legacy.id)!;
    const phaseNames = repaired.phases.map((phase) => phase.phase);

    expect(phaseNames).toContain("sync-ptp-cache");
    expect(phaseNames.indexOf("sync-ptp-cache")).toBeGreaterThan(phaseNames.indexOf("upload"));
    expect(phaseNames.indexOf("sync-ptp-cache")).toBeLessThan(phaseNames.indexOf("post-hook"));
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

  it("returns failed uploads to review so they can be uploaded again", () => {
    const repo = new JobRepository();
    let job = repo.markPreparedForReview(repo.create({ candidate }).id, { uploadReadiness: "ready", artifacts: {} })!;

    job = repo.startUpload(job.id)!;
    job = repo.markUploadFailed(job.id, "Upload to PTP failed: missing tags")!;
    job = repo.retryFailed(job.id)!;

    expect(job.state).toBe("review");
    expect(job.phase).toBe("review");
    expect(job.humanStep).toBe("Review upload package");
    expect(job.phases.find((phase) => phase.phase === "upload")).toMatchObject({
      state: "pending",
      retryCount: 1,
      message: "Retry queued."
    });

    job = repo.startUpload(job.id)!;
    expect(job.state).toBe("uploading");
    expect(job.phase).toBe("upload");
  });

  it("recovers upload retries that were left queued in preparation", () => {
    const repo = new JobRepository();
    let job = repo.markPreparedForReview(repo.create({ candidate }).id, { uploadReadiness: "ready", artifacts: {} })!;
    job = repo.startUpload(job.id)!;
    job.state = "preparing";
    job.phase = "upload";
    job.humanStep = "Preparing upload package";
    const upload = job.phases.find((phase) => phase.phase === "upload")!;
    upload.state = "pending";
    upload.retryCount = 1;
    upload.message = "Retry queued.";

    job = repo.retryFailed(job.id)!;

    expect(job.state).toBe("review");
    expect(job.phase).toBe("review");
    expect(job.humanStep).toBe("Review upload package");
    expect(job.phases.find((phase) => phase.phase === "upload")).toMatchObject({
      state: "pending",
      retryCount: 2,
      message: "Retry queued."
    });
  });

  it("queues retry for completed screenshot phase and dependent evidence phases", () => {
    const repo = new JobRepository();
    let job = repo.markPreparedForReview(repo.create({ candidate }).id, { uploadReadiness: "ready", artifacts: {} })!;
    for (const phase of job.phases) phase.state = "done";

    job = repo.retryCompletedPhase(job.id, "screenshots")!;

    expect(job.state).toBe("preparing");
    expect(job.phase).toBe("screenshots");
    expect(job.phases.find((phase) => phase.phase === "screenshots")).toMatchObject({ state: "pending", retryCount: 1, message: "Retry queued." });
    expect(job.phases.find((phase) => phase.phase === "image-host-upload")).toMatchObject({ state: "pending", message: "Waiting for screenshots retry." });
    expect(job.phases.find((phase) => phase.phase === "preflight")).toMatchObject({ state: "pending", message: "Waiting for screenshots retry." });
    expect(job.phases.find((phase) => phase.phase === "review")).toMatchObject({ state: "pending", message: "Waiting for screenshots retry." });
  });

  it("queues inspect-media retry without resetting screenshots", () => {
    const repo = new JobRepository();
    let job = repo.markPreparedForReview(repo.create({ candidate }).id, { uploadReadiness: "ready", artifacts: {} })!;
    for (const phase of job.phases) phase.state = "done";

    job = repo.retryCompletedPhase(job.id, "inspect-media")!;

    expect(job.state).toBe("preparing");
    expect(job.phase).toBe("inspect-media");
    expect(job.phases.find((phase) => phase.phase === "inspect-media")).toMatchObject({ state: "pending", retryCount: 1 });
    expect(job.phases.find((phase) => phase.phase === "screenshots")).toMatchObject({ state: "done" });
    expect(job.phases.find((phase) => phase.phase === "preflight")).toMatchObject({ state: "pending", message: "Waiting for inspect-media retry." });
  });

  it("keeps manually cleared edition information from being re-added by media suggestions", () => {
    const repo = new JobRepository();
    let job = repo.create({ candidate });
    const suggestedArtifacts = {
      mediaFeatureSuggestions: ["HDR10"],
      releaseName: "Movie.2024.1080p.BluRay.x264-GROUP"
    };

    job = repo.markPreparationResult(job.id, {
      state: "review",
      phase: "review",
      uploadReadiness: "ready",
      humanStep: "Review upload package",
      artifacts: suggestedArtifacts,
      phases: job.phases,
      eventLevel: "info",
      eventMessage: "Upload package ready for review."
    })!;
    expect(job.reviewDraft?.remaster).toBe(true);
    expect(job.reviewDraft?.remasterTitle).toBe("HDR10");

    job = repo.updateReviewDraft(job.id, { remaster: false, remasterTitle: "" })!;
    job = repo.markPreparationResult(job.id, {
      state: "review",
      phase: "review",
      uploadReadiness: "ready",
      humanStep: "Review upload package",
      artifacts: suggestedArtifacts,
      phases: job.phases,
      eventLevel: "info",
      eventMessage: "Upload package ready for review."
    })!;

    expect(job.reviewDraft?.remaster).toBe(false);
    expect(job.reviewDraft?.remasterTitle).toBe("");
  });

  it("refreshes generated draft descriptions after evidence retries when the draft was not edited", () => {
    const repo = new JobRepository();
    const oldDescription = "General\nFormat                                   : Matroska\n";
    const nextDescription = `${oldDescription}\n[img]https://img.example/screenshot-01.png[/img]`;
    let job = repo.markPreparedForReview(repo.create({ candidate }).id, {
      uploadReadiness: "missing_evidence",
      artifacts: {
        mediaInfoText: oldDescription,
        mediainfo: oldDescription,
        description: oldDescription
      }
    })!;

    expect(job.reviewDraft?.description).toBe(oldDescription);

    job = repo.markPreparationResult(job.id, {
      state: "review",
      phase: "review",
      uploadReadiness: "ready",
      humanStep: "Review upload package",
      artifacts: {
        ...job.artifacts,
        screenshots: ["https://img.example/screenshot-01.png", "https://img.example/screenshot-02.png", "https://img.example/screenshot-03.png"],
        uploadTorrent: "torrent/upload.torrent",
        description: nextDescription
      },
      phases: job.phases,
      eventLevel: "info",
      eventMessage: "Phase retry ready for review."
    })!;

    expect(job.reviewDraft?.description).toBe(nextDescription);

    job = repo.updateReviewDraft(job.id, { description: "Manual description" })!;
    job = repo.markPreparationResult(job.id, {
      state: "review",
      phase: "review",
      uploadReadiness: "ready",
      humanStep: "Review upload package",
      artifacts: {
        ...job.artifacts,
        description: `${nextDescription}\n[img]https://img.example/screenshot-04.png[/img]`
      },
      phases: job.phases,
      eventLevel: "info",
      eventMessage: "Phase retry ready for review."
    })!;

    expect(job.reviewDraft?.description).toBe("Manual description");
  });

  it("rejects completed-phase retry for unsafe phases", () => {
    const repo = new JobRepository();
    let job = repo.markPreparedForReview(repo.create({ candidate }).id, { uploadReadiness: "ready", artifacts: {} })!;
    for (const phase of job.phases) phase.state = "done";

    job = repo.retryCompletedPhase(job.id, "upload")!;

    expect(job.events.at(0)?.message).toBe("Phase retry is not available for upload.");
    expect(job.phases.find((phase) => phase.phase === "upload")).toMatchObject({ state: "done", retryCount: 0 });
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
