import { describe, expect, it } from "vitest";
import { buildPtpGroupUrl, formatPtpMovieTitle, mediaTitleFromPath, ptpTargetFromMovie, VIDEO_FILE_EXTENSIONS } from "./manual-intake.js";

describe("manual intake helpers", () => {
  it("builds display titles and clickable PTP group URLs", () => {
    const target = ptpTargetFromMovie({
      GroupId: "205678",
      Title: "Skaz pro to, kak tsar Pyotr arapa zhenil",
      Name: "How Czar Peter the Great Married Off His Moor",
      Year: "1976",
      ImdbId: "tt0075169",
      Torrents: []
    });

    expect(target).toMatchObject({
      groupId: "205678",
      displayTitle: "Skaz pro to, kak tsar Pyotr arapa zhenil AKA How Czar Peter the Great Married Off His Moor [1976]",
      imdbId: "tt0075169",
      ptpUrl: "https://passthepopcorn.me/torrents.php?id=205678"
    });
  });

  it("returns null when a PTP movie has no group id", () => {
    expect(ptpTargetFromMovie({ Title: "No Group", Year: "2024", Torrents: [] })).toBeNull();
  });

  it("derives release titles from media file paths", () => {
    expect(mediaTitleFromPath("/home/emt/data/Movie.2024.1080p.WEB-DL.mkv")).toBe("Movie.2024.1080p.WEB-DL");
    expect(mediaTitleFromPath("/home/emt/data/Directory.Movie.2024.1080p.WEB-DL.x265-GROUP")).toBe("Directory.Movie.2024.1080p.WEB-DL.x265-GROUP");
    expect(VIDEO_FILE_EXTENSIONS.has(".mkv")).toBe(true);
    expect(VIDEO_FILE_EXTENSIONS.has(".txt")).toBe(false);
    expect(formatPtpMovieTitle({ GroupId: "1", Title: "Only Title", Year: "2025", Torrents: [] })).toBe("Only Title [2025]");
    expect(buildPtpGroupUrl("12 3")).toBe("https://passthepopcorn.me/torrents.php?id=12%203");
  });
});
