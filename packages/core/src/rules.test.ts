import { describe, expect, it } from "vitest";
import {
  buildUploadPlan,
  evaluatePtpCoexistence,
  makePtpCacheKey,
  normalizePtpResponse,
  parseTorrentTitle
} from "./index.js";

describe("PTP cache", () => {
  it("prefers IMDb cache keys", () => {
    expect(makePtpCacheKey({ imdbId: "https://www.imdb.com/title/tt0816692/", title: "Interstellar.2014.1080p.BluRay.x264" })).toBe("ptp:imdb:tt0816692");
  });

  it("uses stable title/year cache keys when IMDb is unavailable", () => {
    expect(makePtpCacheKey({ imdbId: null, title: "Interstellar.2014.1080p.BluRay.x264" })).toBe("ptp:search:interstellar|2014");
  });
});

describe("Upsies-style upload plan", () => {
  it("generates release metadata, screenshot plan, and torrent reuse guidance", () => {
    const plan = buildUploadPlan({
      candidate: {
        site: "mteam",
        title: "Perfect.Days.2023.1080p.BluRay.FLAC.x264-GROUP",
        imdbId: "tt27503384",
        sourceTorrentId: "12345"
      },
      torrentBytes: 65536
    });

    expect(plan.releaseName.generated).toBe("Perfect.Days.2023.1080p.BluRay.x264-GROUP");
    expect(plan.metadata.providers.find((provider) => provider.provider === "imdb")?.status).toBe("ready");
    expect(plan.screenshots.count).toBe(4);
    expect(plan.torrentReuse.strategy).toBe("reuse-source-torrent");
    expect(plan.torrentReuse.preservePieceHashes).toBe(true);
  });

  it("opens review gates for PTP container and banned group rules", () => {
    const plan = buildUploadPlan({
      candidate: {
        site: "unknown",
        title: "Movie.2024.1080p.BluRay.x264-YIFY.mp4",
        imdbId: null
      }
    });

    expect(plan.reviewGates.some((gate) => gate.id === "rule:ptp_banned_group" && gate.severity === "blocker")).toBe(true);
    expect(plan.reviewGates.some((gate) => gate.id === "rule:ptp_mp4_container" && gate.severity === "blocker")).toBe(true);
    expect(plan.reviewGates.some((gate) => gate.id === "rule:missing_imdb" && gate.severity === "warning")).toBe(true);
  });
});

describe("PTP coexisting rules", () => {
  it("marks a missing movie as new when an IMDb ID is available", () => {
    const decision = evaluatePtpCoexistence({ movies: [] }, parseTorrentTitle("Movie.2024.1080p.WEB-DL.x264", "1080p"), "tt1234567");
    expect(decision.status).toBe("not_found");
  });

  it("marks an empty movie group as uploadable", () => {
    const data = normalizePtpResponse({
      Page: "Details",
      GroupId: "100",
      Name: "Test",
      Year: "2024",
      Torrents: []
    });
    const decision = evaluatePtpCoexistence(data, parseTorrentTitle("Test.2024.1080p.WEB-DL.x264", "1080p"), "tt1234567");
    expect(decision.status).toBe("no_torrents");
    expect(decision.ptpUrl).toBe("https://passthepopcorn.me/torrents.php?id=100");
  });

  it("detects a full 1080p SDR encode slot", () => {
    const data = normalizePtpResponse({
      Page: "Details",
      GroupId: "100",
      Name: "Test",
      Year: "2024",
      Torrents: [
        {
          Quality: "Encode",
          Source: "Blu-ray",
          Codec: "x264",
          Resolution: "1080p",
          ReleaseName: "Test.2024.1080p.BluRay.x264-GRP"
        }
      ]
    });
    const decision = evaluatePtpCoexistence(data, parseTorrentTitle("Test.2024.1080p.WEB-DL.x264", "1080p"), "tt1234567");
    expect(decision.status).toBe("full");
  });

  it("opens a distinct 1080p HDR x265 slot", () => {
    const data = normalizePtpResponse({
      Page: "Details",
      GroupId: "100",
      Name: "Test",
      Year: "2024",
      Torrents: [
        {
          Quality: "Encode",
          Source: "Blu-ray",
          Codec: "x264",
          Resolution: "1080p",
          ReleaseName: "Test.2024.1080p.BluRay.x264-GRP"
        }
      ]
    });
    const decision = evaluatePtpCoexistence(data, parseTorrentTitle("Test.2024.1080p.WEB-DL.x265.HDR", "1080p"), "tt1234567");
    expect(decision.status).toBe("open");
    expect(decision.slotType).toBe("1080p HDR x265");
  });

  it("treats one 2160p SDR encode as a possible coexist case", () => {
    const data = normalizePtpResponse({
      Page: "Details",
      GroupId: "100",
      Name: "Test",
      Year: "2024",
      Torrents: [
        {
          Quality: "Encode",
          Source: "WEB",
          Codec: "x265",
          Resolution: "2160p",
          ReleaseName: "Test.2024.2160p.WEB-DL.x265-GRP"
        }
      ]
    });
    const decision = evaluatePtpCoexistence(data, parseTorrentTitle("Test.2024.2160p.WEB-DL.x265", "2160p"), "tt1234567");
    expect(decision.status).toBe("coexist");
  });
});
