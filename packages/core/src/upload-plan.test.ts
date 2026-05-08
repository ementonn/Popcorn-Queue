import { describe, expect, it } from "vitest";
import {
  buildUploadPlan,
  parseTorrentTitle,
  UPLOAD_PHASES,
  type BrowserCheckResult,
  type RuleDecision,
  type TorrentCandidate
} from "./index.js";

function checkResult(candidate: TorrentCandidate, decision: RuleDecision): BrowserCheckResult {
  return {
    candidate,
    parsed: parseTorrentTitle(candidate.title, candidate.resolution),
    decision,
    cache: {
      key: "ptp:imdb:tt1234567",
      hit: false,
      policy: "permanent"
    }
  };
}

function decision(status: RuleDecision["status"], reason: string): RuleDecision {
  return {
    status,
    movieFound: true,
    reason,
    confidence: "high"
  };
}

describe("upload plan review gates", () => {
  it("uses the pre-upload automation phase vocabulary", () => {
    expect(UPLOAD_PHASES).toEqual([
      "intake",
      "duplicate-check",
      "metadata",
      "download-or-locate",
      "prepare-media",
      "inspect-media",
      "screenshots",
      "image-host-upload",
      "torrent-create",
      "seed-prepare",
      "preflight",
      "review",
      "upload",
      "post-hook",
      "done"
    ]);
    expect(UPLOAD_PHASES).not.toContain("download");
    expect(UPLOAD_PHASES).not.toContain("extract");
    expect(UPLOAD_PHASES).not.toContain("analyze");
    expect(UPLOAD_PHASES).not.toContain("seed-start");
  });

  it("starts clean plans at intake and blocker plans at preflight", () => {
    const clean = buildUploadPlan({
      candidate: {
        site: "mteam",
        title: "Clean.Movie.2024.1080p.BluRay.x264-GROUP",
        imdbId: "tt7654321"
      }
    });
    expect(clean.recommendedStartPhase).toBe("intake");

    const blockedCandidate: TorrentCandidate = {
      site: "mteam",
      title: "Blocked.Movie.2024.1080p.BluRay.x264-YIFY.mp4",
      imdbId: null
    };
    const blocked = buildUploadPlan({ candidate: blockedCandidate });
    expect(blocked.recommendedStartPhase).toBe("preflight");
  });

  it("turns full PTP slots into blocker gates and starts at preflight", () => {
    const candidate: TorrentCandidate = {
      site: "mteam",
      title: "Test.Movie.2024.1080p.BluRay.x264-GROUP",
      imdbId: "tt1234567",
      resolution: "1080p"
    };

    const plan = buildUploadPlan({
      candidate,
      checkResult: checkResult(candidate, decision("full", "The 1080p SDR x264 slot is already full."))
    });

    expect(plan.reviewGates).toContainEqual(
      expect.objectContaining({
        id: "duplicate:slot-full",
        severity: "blocker",
        status: "open"
      })
    );
    expect(plan.recommendedStartPhase).toBe("preflight");
  });

  it("turns coexist decisions into warning gates and starts at intake", () => {
    const candidate: TorrentCandidate = {
      site: "mteam",
      title: "Test.Movie.2024.2160p.WEB-DL.x265-GROUP",
      imdbId: "tt1234567",
      resolution: "2160p"
    };

    const plan = buildUploadPlan({
      candidate,
      checkResult: checkResult(candidate, decision("coexist", "Existing 2160p slot may allow coexistence."))
    });

    expect(plan.reviewGates).toContainEqual(
      expect.objectContaining({
        id: "duplicate:coexist",
        severity: "warning",
        status: "open"
      })
    );
    expect(plan.recommendedStartPhase).toBe("intake");
  });

  it("lets callers prioritize a configured image host", () => {
    const plan = buildUploadPlan({
      candidate: {
        site: "unknown",
        title: "Movie.2024.1080p.BluRay.x264-GROUP"
      },
      imageHosts: ["imgbb", "ptpimg"]
    });

    expect(plan.screenshots.imageHosts).toEqual(["imgbb", "ptpimg"]);
  });
});
