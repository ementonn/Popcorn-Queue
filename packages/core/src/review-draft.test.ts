import { describe, expect, it } from "vitest";
import { buildUploadPlan } from "./upload-plan.js";
import { buildReviewDraft, mergeReviewDraft } from "./review-draft.js";
import { ptpFormFieldsFromDraft } from "./ptp-form-fields.js";
import { buildReleaseDescription } from "./release-description.js";
import type { TorrentCandidate } from "./types.js";

const candidate: TorrentCandidate = {
  site: "pter",
  title: "Movie.2024.1080p.WEB-DL.H265.HDR.AAC-GROUP",
  imdbId: "tt1234567",
  resolution: "1080p"
};

describe("review draft contract", () => {
  it("builds PTP release description from text mediainfo and screenshots", () => {
    const description = buildReleaseDescription({
      releaseName: "Movie.2025.1080p.WEB-DL.x265-GROUP",
      mediaInfoText: "General\nComplete name                            : Movie.mkv",
      screenshots: ["https://img.example/1.png", "https://img.example/2.png", "https://img.example/3.png"]
    });

    expect(description).toContain("[size=4][b]Movie.2025.1080p.WEB-DL.x265-GROUP[/b][/size]");
    expect(description).toContain("General");
    expect(description).not.toContain("MediaInfo:");
    expect(description).toContain("\n\nGeneral\nComplete name                            : Movie.mkv\n\n");
    expect(description).toContain("[img]https://img.example/1.png[/img]");
  });

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
      source: "WEB",
      imdb: "tt1234567",
      title: "Movie",
      year: "2024",
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
      subtitles: "English, Chinese, Brazilian Portuguese, Welsh, English - Forced, English",
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
      subtitles: ["3", "14", "49", "55", "50"],
      trumpable: ["14", "4"],
      scene: true,
      personalRip: true,
      internal: false
    });
  });

  it("maps draft values to real PTP upload field names", () => {
    const { fields, missing } = ptpFormFieldsFromDraft({
      releaseName: "Movie.2025.1080p.WEB-DL.x265-GROUP",
      description: "Description",
      groupId: "123",
      type: "Feature Film",
      source: "WEB",
      codec: "H.265",
      container: "MKV",
      resolution: "1080p",
      imdb: "tt1234567",
      title: "Movie",
      year: "2025",
      image: "",
      trailer: "",
      tags: "drama",
      synopsis: "",
      remaster: false,
      remasterYear: "",
      remasterTitle: "",
      special: "",
      subtitles: ["3"],
      trumpable: ["14"],
      scene: false,
      personalRip: true,
      internal: false,
      uploadToken: "token",
      artists: [{ name: "Director Name", importance: "1" }]
    });

    expect(missing).toEqual([]);
    expect(fields).toContainEqual(["type", "Feature Film"]);
    expect(fields).toContainEqual(["source", "WEB"]);
    expect(fields).toContainEqual(["codec", "H.265"]);
    expect(fields).toContainEqual(["container", "MKV"]);
    expect(fields).toContainEqual(["resolution", "1080p"]);
    expect(fields).toContainEqual(["imdb", "tt1234567"]);
    expect(fields).toContainEqual(["artist[]", "Director Name"]);
    expect(fields).toContainEqual(["importance[]", "1"]);
    expect(fields).toContainEqual(["subtitles[]", "3"]);
    expect(fields).toContainEqual(["trumpable[]", "14"]);
  });
});
