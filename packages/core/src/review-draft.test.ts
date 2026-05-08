import { describe, expect, it } from "vitest";
import { buildUploadPlan } from "./upload-plan.js";
import { buildReviewDraft, mergeReviewDraft } from "./review-draft.js";
import type { TorrentCandidate } from "./types.js";

const candidate: TorrentCandidate = {
  site: "pter",
  title: "Movie.2024.1080p.WEB-DL.H265.HDR.AAC-GROUP",
  imdbId: "tt1234567",
  resolution: "1080p"
};

describe("review draft contract", () => {
  it("initializes PTP upload fields from upload plan and artifacts", () => {
    const uploadPlan = buildUploadPlan({ candidate });

    const draft = buildReviewDraft({
      candidate,
      uploadPlan,
      artifacts: {
        releaseName: "Movie.2024.1080p.WEB.x265.HDR-GROUP",
        description: "Release description",
        mediainfo: "General\nFormat: Matroska"
      },
      checkResult: {
        candidate,
        parsed: uploadPlan.parsed,
        decision: {
          status: "open",
          movieFound: true,
          reason: "slot open",
          confidence: "high",
          ptpUrl: "https://passthepopcorn.me/torrents.php?id=123"
        },
        cache: { key: "ptp:imdb:tt1234567", hit: false, policy: "permanent" }
      }
    });

    expect(draft).toMatchObject({
      releaseName: "Movie.2024.1080p.WEB.x265.HDR-GROUP",
      description: "Release description",
      groupId: "123",
      type: "Feature Film",
      codec: "H.265",
      container: "MKV",
      resolution: "1080p",
      source: "WEB-DL",
      scene: true,
      personalRip: false,
      internal: false
    });
  });

  it("normalizes editable review draft patches", () => {
    const uploadPlan = buildUploadPlan({ candidate });
    const initial = buildReviewDraft({ candidate, uploadPlan, artifacts: {} });

    const draft = mergeReviewDraft(initial, {
      releaseName: "  Edited.Release  ",
      description: "  Desc  ",
      groupId: "",
      remasterYear: 2024,
      subtitles: "English, Chinese, English",
      trumpable: ["No English subtitles", "", "Hardcoded subs"],
      scene: "true",
      personalRip: 1,
      internal: 0
    });

    expect(draft).toMatchObject({
      releaseName: "Edited.Release",
      description: "Desc",
      groupId: null,
      remasterYear: "2024",
      subtitles: ["English", "Chinese"],
      trumpable: ["No English subtitles", "Hardcoded subs"],
      scene: true,
      personalRip: true,
      internal: false
    });
  });
});
