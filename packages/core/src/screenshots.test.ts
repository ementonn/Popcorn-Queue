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
  it("defaults to four randomized timestamps", () => {
    const plan = buildScreenshotPlan(parsed, 7200, { rng: () => 0.5 });

    expect(plan.timestamps).toHaveLength(4);
    expect(plan.count).toBe(4);
  });

  it("changes timestamps when the random source changes", () => {
    const first = buildScreenshotPlan(parsed, 7200, { rng: () => 0.1 });
    const second = buildScreenshotPlan(parsed, 7200, { rng: () => 0.9 });

    expect(first.timestamps.map((timestamp) => timestamp.seconds)).not.toEqual(second.timestamps.map((timestamp) => timestamp.seconds));
  });

  it("keeps timestamps inside short fixture videos", () => {
    const plan = buildScreenshotPlan(parsed, 2);

    expect(plan.timestamps).toHaveLength(4);
    expect(plan.timestamps.every((timestamp) => timestamp.seconds >= 0 && timestamp.seconds < 2)).toBe(true);
  });
});
