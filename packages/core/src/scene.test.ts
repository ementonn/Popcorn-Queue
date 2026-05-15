import { describe, expect, it } from "vitest";
import { buildSceneCheckPlan } from "./scene.js";

describe("scene group detection", () => {
  it("does not treat unknown uppercase WEB groups as scene", () => {
    const plan = buildSceneCheckPlan({
      site: "unknown",
      title: "Cosmicrew.Ice.Planet.2026.1080p.WEB.x264-HHWEB"
    });

    expect(plan.releaseGroup).toBe("HHWEB");
    expect(plan.status).toBe("not_scene");
    expect(plan.evidence).toContain("Release group is not in the known scene group cache.");
  });

  it("treats known scene groups as scene", () => {
    const plan = buildSceneCheckPlan({
      site: "unknown",
      title: "Movie.2024.1080p.BluRay.x264-SPARKS"
    });

    expect(plan.releaseGroup).toBe("SPARKS");
    expect(plan.status).toBe("likely_scene");
    expect(plan.evidence).toContain("Release group is in the known scene group cache.");
  });
});
