import type { ParsedTorrentCandidate, TorrentCandidate } from "./types.js";
import { extractContainer } from "./release.js";

export interface MediaInspectionPlan {
  container: string | null;
  discType: "uhd_disc" | "bluray_disc" | "dvd_disc" | "file";
  audio: {
    codecs: string[];
    languages: string[];
    commentaryLikely: boolean;
  };
  subtitles: {
    languages: string[];
    embeddedLikely: boolean;
  };
  trumpableChecks: string[];
}

function inferAudioCodecs(title: string): string[] {
  const upper = title.toUpperCase();
  const codecs: string[] = [];
  if (/\bTRUEHD\b/.test(upper)) codecs.push("TrueHD");
  if (/\bATMOS\b/.test(upper)) codecs.push("Atmos");
  if (/\bDTS[\s._-]?HD[\s._-]?MA\b/.test(upper)) codecs.push("DTS-HD MA");
  if (/\bDTS[\s._-]?X\b/.test(upper)) codecs.push("DTS:X");
  if (/\bFLAC\b/.test(upper)) codecs.push("FLAC");
  if (/\bAAC\b/.test(upper)) codecs.push("AAC");
  if (/\bAC3\b|\bDDP?\b/.test(upper)) codecs.push("AC3/DDP");
  return codecs;
}

function inferLanguages(title: string): string[] {
  const upper = title.toUpperCase();
  const languages: string[] = [];
  if (/\bFRENCH\b|\bFR\b/.test(upper)) languages.push("French");
  if (/\bGERMAN\b|\bDE\b/.test(upper)) languages.push("German");
  if (/\bJAPANESE\b|\bJPN\b/.test(upper)) languages.push("Japanese");
  if (/\bMANDARIN\b|\bCHINESE\b|\bCHS\b|\bCHT\b/.test(upper)) languages.push("Chinese");
  if (languages.length === 0) languages.push("English");
  return Array.from(new Set(languages));
}

function inferDiscType(parsed: ParsedTorrentCandidate): MediaInspectionPlan["discType"] {
  if (parsed.qualityType !== "Untouched") return "file";
  if (parsed.resolution === "2160p") return "uhd_disc";
  if (parsed.source === "DVD") return "dvd_disc";
  return "bluray_disc";
}

export function buildMediaInspectionPlan(candidate: TorrentCandidate, parsed: ParsedTorrentCandidate): MediaInspectionPlan {
  const audioCodecs = inferAudioCodecs(candidate.title);
  const languages = inferLanguages(candidate.title);
  const container = extractContainer(candidate.title);
  const trumpableChecks = [
    "Verify audio language metadata.",
    "Verify subtitle language metadata.",
    "Check for commentary-only default tracks.",
    "Check source-specific trumpable rules before upload."
  ];

  if (container === "MP4") trumpableChecks.unshift("Remux MP4 container to MKV.");
  if (!audioCodecs.length) trumpableChecks.unshift("Run MediaInfo before preflight; no audio codec was inferred from title.");

  return {
    container,
    discType: inferDiscType(parsed),
    audio: {
      codecs: audioCodecs,
      languages,
      commentaryLikely: /\bCOMMENTARY\b/i.test(candidate.title)
    },
    subtitles: {
      languages: /\bSUBS?\b|\bMULTISUB\b|\bCHS\b|\bCHT\b/i.test(candidate.title) ? languages : [],
      embeddedLikely: container === "MKV"
    },
    trumpableChecks
  };
}
