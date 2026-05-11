import { describe, expect, it } from "vitest";
import { detectMediaFeatures } from "./media-features.js";

function mediaInfoJson(video: Record<string, unknown>, audio: Array<Record<string, unknown>> = []): string {
  return JSON.stringify({
    media: {
      track: [
        { "@type": "General", Duration: "7200" },
        { "@type": "Video", ...video },
        ...audio.map((track) => ({ "@type": "Audio", ...track }))
      ]
    }
  });
}

describe("media feature detection", () => {
  it("detects Dolby Vision from MediaInfo HDR format", () => {
    const result = detectMediaFeatures({ mediaInfoJson: mediaInfoJson({ HDR_Format: "Dolby Vision" }) });

    expect(result.hdrFormats).toEqual(["DV"]);
    expect(result.editionFeatures).toContain("Dolby Vision");
  });

  it("detects HDR10+ and HDR10 from MediaInfo compatibility", () => {
    expect(detectMediaFeatures({ mediaInfoJson: mediaInfoJson({ HDR_Format_Compatibility: "HDR10+ Profile B" }) }).hdrFormats).toEqual(["HDR10+"]);
    expect(detectMediaFeatures({ mediaInfoJson: mediaInfoJson({ HDR_Format_Compatibility: "HDR10" }) }).hdrFormats).toEqual(["HDR10"]);
  });

  it("detects HDR10 from BT.2020 primaries unless Dolby Vision profile 5 is present", () => {
    expect(detectMediaFeatures({ mediaInfoJson: mediaInfoJson({ colour_primaries: "BT.2020" }) }).hdrFormats).toEqual(["HDR10"]);
    expect(detectMediaFeatures({ mediaInfoJson: mediaInfoJson({ HDR_Format: "Dolby Vision", HDR_Format_Profile: "dvhe.05", colour_primaries: "BT.2020" }) }).hdrFormats).toEqual([
      "DV"
    ]);
  });

  it("detects generic HDR markers", () => {
    const result = detectMediaFeatures({ mediaInfoJson: mediaInfoJson({ HDR_Format: "SMPTE ST 2086, HDR metadata" }) });

    expect(result.hdrFormats).toEqual(["HDR"]);
  });

  it("suppresses the 10-bit feature when HDR or Dolby Vision is present", () => {
    expect(detectMediaFeatures({ mediaInfoJson: mediaInfoJson({ BitDepth: "10" }) }).editionFeatures).toContain("10-bit");
    expect(detectMediaFeatures({ mediaInfoJson: mediaInfoJson({ BitDepth: "10", HDR_Format_Compatibility: "HDR10" }) }).editionFeatures).not.toContain("10-bit");
  });

  it("detects audio feature suggestions", () => {
    const result = detectMediaFeatures({
      mediaInfoJson: mediaInfoJson(
        {},
        [
          { Format_Commercial_IfAny: "Dolby Digital Plus with Dolby Atmos", Language: "en" },
          { Format: "DTS:X", Title: "English commentary", Language: "fr" }
        ]
      )
    });

    expect(result.editionFeatures).toEqual(expect.arrayContaining(["Dolby Atmos", "DTS:X", "Dual Audio", "With Commentary"]));
  });

  it("detects 3D feature suggestions from release names", () => {
    expect(detectMediaFeatures({ releaseName: "Movie.2024.1080p.BluRay.3D.Full-SBS.x264-GROUP" }).editionFeatures).toContain("3D Full SBS");
    expect(detectMediaFeatures({ releaseName: "Movie.2024.1080p.BluRay.HSBS.x264-GROUP" }).editionFeatures).toContain("3D Half SBS");
    expect(detectMediaFeatures({ releaseName: "Movie.2024.1080p.BluRay.HOU.x264-GROUP" }).editionFeatures).toContain("3D Half OU");
    expect(detectMediaFeatures({ releaseName: "Movie.2024.1080p.BluRay.Anaglyph.x264-GROUP" }).editionFeatures).toContain("3D Anaglyph");
    expect(detectMediaFeatures({ releaseName: "Movie.2024.1080p.BluRay.2D3D.x264-GROUP" }).editionFeatures).toContain("2D/3D Edition");
  });
});
