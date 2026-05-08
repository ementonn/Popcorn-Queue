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
