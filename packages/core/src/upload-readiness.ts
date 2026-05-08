import type { ReviewGate } from "./upload-plan.js";

export type UploadReadiness = "blocked" | "missing_evidence" | "ready";

export interface EvidenceRequirement {
  id: string;
  label: string;
  present: boolean;
  blocksUpload: boolean;
  detail?: string;
}

export function computeUploadReadiness(
  reviewGates: ReviewGate[],
  evidence: EvidenceRequirement[] = []
): UploadReadiness {
  if (reviewGates.some((gate) => gate.status === "open" && gate.severity === "blocker")) return "blocked";
  if (evidence.some((item) => item.blocksUpload && !item.present)) return "missing_evidence";
  return "ready";
}
