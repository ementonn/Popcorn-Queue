import type { ParsedTorrentCandidate, TorrentCandidate } from "./types.js";
import { extractContainer, extractReleaseGroup } from "./release.js";

export type UploadRuleLevel = "block" | "review" | "info";

export interface UploadRuleFinding {
  level: UploadRuleLevel;
  code: string;
  message: string;
  source: "ptp" | "popcorn-queue";
}

export const PTP_BANNED_RELEASE_GROUPS = new Set([
  "aXXo",
  "BMDRu",
  "BRrip",
  "CM8",
  "CrEwSaDe",
  "CTFOH",
  "d3g",
  "DNL",
  "FaNGDiNG0",
  "HD2DVD",
  "HDT",
  "HDTime",
  "ION10",
  "iPlanet",
  "KiNGDOM",
  "LAMA",
  "mHD",
  "mSD",
  "NhaNc3",
  "nHD",
  "nikt0",
  "nSD",
  "OFT",
  "PRODJi",
  "SANTi",
  "SasukeducK",
  "SPiRiT",
  "STUTTERSHIT",
  "ViSION",
  "VXT",
  "WAF",
  "WORLD",
  "x0r",
  "YIFY"
]);

function isBannedGroup(group: string): boolean {
  const lower = group.toLowerCase();
  return Array.from(PTP_BANNED_RELEASE_GROUPS).some((item) => item.toLowerCase() === lower);
}

export function evaluatePtpUploadRules(candidate: TorrentCandidate, parsed: ParsedTorrentCandidate): UploadRuleFinding[] {
  const findings: UploadRuleFinding[] = [];
  const group = extractReleaseGroup(candidate.title);
  const container = extractContainer(candidate.title);

  if (group && isBannedGroup(group)) {
    findings.push({
      level: "block",
      code: "ptp_banned_group",
      message: `${group} is on the PTP banned release group list.`,
      source: "ptp"
    });
  }

  if (group?.toLowerCase() === "evo" && parsed.source !== "WEB") {
    findings.push({
      level: "block",
      code: "ptp_evo_encode",
      message: "EVO is only acceptable for WEB-DL style releases; encodes need to be blocked.",
      source: "ptp"
    });
  }

  if (container === "MP4" || /\bMP4\b/i.test(candidate.title)) {
    findings.push({
      level: "block",
      code: "ptp_mp4_container",
      message: "MP4 must be remuxed into MKV before a PTP upload.",
      source: "ptp"
    });
  }

  if (!candidate.imdbId) {
    findings.push({
      level: "review",
      code: "missing_imdb",
      message: "IMDb ID is missing; duplicate checks and metadata autofill are lower confidence.",
      source: "popcorn-queue"
    });
  }

  if (!parsed.resolution || !parsed.codec || !parsed.source) {
    findings.push({
      level: "review",
      code: "incomplete_release_parse",
      message: "Release parsing is incomplete; verify source, codec, and resolution before upload.",
      source: "popcorn-queue"
    });
  }

  return findings;
}
