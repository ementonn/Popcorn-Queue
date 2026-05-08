import { describe, expect, it } from "vitest";
import { computeUploadReadiness, type EvidenceRequirement } from "./index.js";
import type { ReviewGate } from "./upload-plan.js";

const blockerGate: ReviewGate = {
  id: "media:missing",
  severity: "blocker",
  status: "open",
  title: "Missing upload media",
  detail: "Final upload media was not prepared."
};

const warningGate: ReviewGate = {
  id: "scene:uncertain",
  severity: "warning",
  status: "open",
  title: "Scene check uncertain",
  detail: "Scene verification needs operator review."
};

const requiredEvidence: EvidenceRequirement = {
  id: "screenshots",
  label: "Screenshots",
  present: false,
  blocksUpload: true,
  detail: "No hosted screenshots are available."
};

describe("computeUploadReadiness", () => {
  it("blocks when an open blocker gate exists", () => {
    expect(computeUploadReadiness([blockerGate], [])).toBe("blocked");
  });

  it("reports missing evidence when blocking evidence is absent", () => {
    expect(computeUploadReadiness([warningGate], [requiredEvidence])).toBe("missing_evidence");
  });

  it("is ready when only warnings remain and blocking evidence is present", () => {
    expect(
      computeUploadReadiness([warningGate], [
        {
          ...requiredEvidence,
          present: true
        }
      ])
    ).toBe("ready");
  });
});
