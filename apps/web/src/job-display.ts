import type { ApiJob } from "./types.js";

const PHASE_LABELS: Record<string, string> = {
  intake: "Intake",
  "duplicate-check": "Duplicate check",
  metadata: "Metadata",
  "download-or-locate": "Download / locate",
  "prepare-media": "Prepare media",
  "inspect-media": "Inspect media",
  screenshots: "Screenshots",
  "image-host-upload": "Image host upload",
  "torrent-create": "Create torrent",
  "seed-prepare": "Seed prepare",
  preflight: "Preflight",
  review: "Review",
  upload: "Upload",
  "post-hook": "Post hook",
  done: "Done"
};

const PHASE_STATE_LABELS: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  warning: "Warning",
  failed: "Failed",
  skipped: "Skipped",
  blocked: "Blocked"
};

function titleCasePhase(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function phaseLabel(phase: string | null | undefined): string {
  if (!phase) return "Pending";
  return PHASE_LABELS[phase] ?? titleCasePhase(phase);
}

export function phaseStateLabel(state: string | null | undefined): string {
  if (!state) return "Pending";
  return PHASE_STATE_LABELS[state] ?? titleCasePhase(state);
}

export function phaseStateTone(state: string | null | undefined): string {
  if (state === "done") return "done";
  if (state === "failed" || state === "blocked") return "failed";
  if (state === "warning") return "warning";
  if (state === "running") return "running";
  if (state === "skipped") return "skipped";
  return "pending";
}

export function currentStepLabel(job: ApiJob): string {
  if (job.state === "done" || job.phase === "done" || job.humanStep === "Upload workflow complete") return "Complete";
  return phaseLabel(job.phase);
}
