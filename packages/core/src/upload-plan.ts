import type { BrowserCheckResult, ParsedTorrentCandidate, RuleDecision, TorrentCandidate } from "./types.js";
import { parseTorrentTitle } from "./parse.js";
import { buildMediaInspectionPlan, type MediaInspectionPlan } from "./media.js";
import { buildMetadataPlan, type MetadataPlan } from "./metadata.js";
import { evaluatePtpUploadRules, type UploadRuleFinding } from "./ptp-upload-rules.js";
import { buildReleaseNamePlan, type ReleaseNamePlan } from "./release.js";
import { buildSceneCheckPlan, type SceneCheckPlan } from "./scene.js";
import { buildScreenshotPlan, type ScreenshotPlan } from "./screenshots.js";
import { buildTorrentReusePlan, type TorrentReusePlan } from "./torrent-reuse.js";

export const UPLOAD_PHASES = [
  "intake",
  "duplicate-check",
  "metadata",
  "download-or-locate",
  "prepare-media",
  "inspect-media",
  "screenshots",
  "image-host-upload",
  "torrent-create",
  "seed-prepare",
  "preflight",
  "review",
  "upload",
  "sync-ptp-cache",
  "post-hook",
  "done"
] as const;

export type UploadPhase = (typeof UPLOAD_PHASES)[number];

export type ReviewGateSeverity = "blocker" | "warning" | "info";
export type ReviewGateStatus = "open" | "resolved";

export interface ReviewGate {
  id: string;
  severity: ReviewGateSeverity;
  status: ReviewGateStatus;
  title: string;
  detail: string;
}

export interface UploadPlan {
  parsed: ParsedTorrentCandidate;
  metadata: MetadataPlan;
  releaseName: ReleaseNamePlan;
  scene: SceneCheckPlan;
  screenshots: ScreenshotPlan;
  torrentReuse: TorrentReusePlan;
  media: MediaInspectionPlan;
  rules: UploadRuleFinding[];
  reviewGates: ReviewGate[];
  recommendedStartPhase: UploadPhase;
}

function gateFromRule(rule: UploadRuleFinding): ReviewGate {
  return {
    id: `rule:${rule.code}`,
    severity: rule.level === "block" ? "blocker" : rule.level === "review" ? "warning" : "info",
    status: "open",
    title: rule.code,
    detail: rule.message
  };
}

function gatesFromDecision(decision?: RuleDecision): ReviewGate[] {
  if (!decision) return [];
  if (decision.status === "full") {
    return [
      {
        id: "duplicate:slot-full",
        severity: "blocker",
        status: "open",
        title: "PTP slot full",
        detail: decision.reason
      }
    ];
  }
  if (decision.status === "trumpable" || decision.status === "coexist" || decision.status === "review") {
    return [
      {
        id: `duplicate:${decision.status}`,
        severity: "warning",
        status: "open",
        title: "Duplicate review",
        detail: decision.reason
      }
    ];
  }
  return [];
}

function recommendedPhase(gates: ReviewGate[]): UploadPhase {
  if (gates.some((gate) => gate.severity === "blocker")) return "preflight";
  return "intake";
}

export function buildUploadPlan(input: {
  candidate: TorrentCandidate;
  checkResult?: BrowserCheckResult;
  torrentBytes?: number;
  durationSeconds?: number;
  imageHosts?: string[];
  screenshotCount?: number;
}): UploadPlan {
  const parsed = input.checkResult?.parsed ?? parseTorrentTitle(input.candidate.title, input.candidate.resolution);
  const metadata = buildMetadataPlan(input.candidate, parsed);
  const releaseName = buildReleaseNamePlan(input.candidate, parsed);
  const scene = buildSceneCheckPlan(input.candidate);
  const screenshotOptions: Parameters<typeof buildScreenshotPlan>[2] = {};
  if (input.imageHosts) screenshotOptions.imageHosts = input.imageHosts;
  if (input.screenshotCount !== undefined) screenshotOptions.count = input.screenshotCount;
  const screenshots = buildScreenshotPlan(parsed, input.durationSeconds, screenshotOptions);
  const torrentReuse = buildTorrentReusePlan(input.candidate, input.torrentBytes);
  const media = buildMediaInspectionPlan(input.candidate, parsed);
  const rules = evaluatePtpUploadRules(input.candidate, parsed);
  const reviewGates = [
    ...rules.map(gateFromRule),
    ...gatesFromDecision(input.checkResult?.decision)
  ];

  return {
    parsed,
    metadata,
    releaseName,
    scene,
    screenshots,
    torrentReuse,
    media,
    rules,
    reviewGates,
    recommendedStartPhase: recommendedPhase(reviewGates)
  };
}
