import { describe, expect, it } from "vitest";
import { buildScreenshotPlan } from "./screenshots.js";
import type { ParsedTorrentCandidate } from "./types.js";

const parsed: ParsedTorrentCandidate = {
  title: "Shock.Wave.2.2020.1080p.WEB-DL.HEVC.HDR.DDP5.1-HVAC",
  searchName: "Shock Wave 2",
  resolution: "1080p",
  qualityType: "WEB-DL",
  codec: "x265",
  hdr: ["HDR"],
  source: "WEB",
  year: "2020"
};

describe("screenshot plans", () => {
  it("keeps timestamps inside short fixture videos", () => {
    const plan = buildScreenshotPlan(parsed, 2);

    expect(plan.timestamps).toHaveLength(6);
    expect(plan.timestamps.every((timestamp) => timestamp.seconds >= 0 && timestamp.seconds < 2)).toBe(true);
  });
});
