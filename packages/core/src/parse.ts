import type { CandidateQuality, HdrType, ParsedTorrentCandidate, Resolution } from "./types.js";

export const RESOLUTION_REGEX = /\b(2160p|1080p|1080i|720p|576p|576i|480p|480i|4K|UHD|NTSC|PAL)\b/i;

export function normalizeImdbId(value?: string | null): string | null {
  if (!value) return null;
  const match = value.match(/tt(\d{7,})/i) ?? value.match(/\b(\d{7,})\b/);
  if (!match) return null;
  return `tt${match[1]}`;
}

export function normalizeResolution(value?: string | null): Resolution | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "4k" || normalized === "uhd") return "2160p";
  if (normalized === "ntsc") return "NTSC";
  if (normalized === "pal") return "PAL";
  if (
    normalized === "480p" ||
    normalized === "480i" ||
    normalized === "576p" ||
    normalized === "576i" ||
    normalized === "720p" ||
    normalized === "1080i" ||
    normalized === "1080p" ||
    normalized === "2160p"
  ) {
    return normalized;
  }
  return "other";
}

export function extractSearchName(title: string): string {
  const bracketMatch = title.match(/\[([A-Za-z][A-Za-z0-9._\s-]+(?:19|20)\d{2}[^\]]*)\]/);
  let raw = bracketMatch?.[1] ?? title;
  raw = raw.replace(/\[.*?\]/g, " ").replace(/【.*?】/g, " ");
  raw = raw.replace(/\b(2160p|1080p|1080i|720p|576p|480p|4K|UHD)\b.*/i, "");
  raw = raw.replace(/(\b(?:19|20)\d{2}\b).*/, "$1");
  raw = raw.replace(/[._]/g, " ").replace(/\s+/g, " ").trim();
  raw = raw.replace(/\s+(19|20)\d{2}$/, "").trim();
  return raw;
}

export function extractYear(title: string): string | undefined {
  return title.match(/\b((?:19|20)\d{2})\b/)?.[1];
}

export function extractQualityType(title: string): CandidateQuality {
  const t = title.toUpperCase();
  if (/\bREMUX\b/.test(t)) return "Remux";
  if (/\bBDMV\b|\bISO\b|\bVOB_IFO\b|\bFULL.?DISC\b|\bBD50\b|\bBD25\b|\bBD66\b|\bBD100\b|\bDVD[59]\b/.test(t)) {
    return "Untouched";
  }
  if (/\bWEB[\s._-]?DL\b/.test(t)) return "WEB-DL";
  const isBluray = /\bBLU[\s._-]?RAY\b/.test(t);
  const hasLosslessAudio = /\bTRUEHD\b|\bDTS[\s._-]?HD[\s._-]?MA\b|\bDTS[\s._-]?X\b|\bLPCM\b|\bFLAC\b/.test(t);
  const hasEncoder = /\bX264\b|\bX265\b/.test(t);
  if (isBluray && hasLosslessAudio && !hasEncoder) return "Remux";
  return "Encode";
}

export function extractCodec(title: string): string | null {
  const t = title.toUpperCase();
  if (/\bX265\b|\bHEVC\b|\bH[\s._]?265\b/.test(t)) return "x265";
  if (/\bX264\b|\bAVC\b|\bH[\s._]?264\b/.test(t)) return "x264";
  if (/\bAV1\b/.test(t)) return "AV1";
  return null;
}

export function extractHdr(title: string): string[] {
  const t = title.toUpperCase();
  const hdr: string[] = [];
  if (/\bDOLBY[\s._]?VISION\b|\bDOVI\b|\bDV\b/i.test(title)) hdr.push("DV");
  if (/\bHDR10\+\b|\bHDR10PLUS\b/.test(t)) hdr.push("HDR10+");
  if (/\bHDR10\b/.test(t)) hdr.push("HDR10");
  if (/\bHDR\b/.test(t) && !hdr.some((item) => item.startsWith("HDR10"))) hdr.push("HDR");
  if (/\bHLG\b/.test(t)) hdr.push("HLG");
  return hdr;
}

export function extractSource(title: string): string | null {
  const t = title.toUpperCase();
  if (/\bBLU[\s._-]?RAY\b|\bBDREMUX\b|\bBDRIP\b|\bBRRIP\b/.test(t)) return "Blu-ray";
  if (/\bWEB[\s._-]?DL\b|\bWEB[\s._-]?RIP\b|\bWEBRIP\b/.test(t)) return "WEB";
  if (/\bHDTV\b/.test(t)) return "HDTV";
  if (/\bDVD\b|\bNTSC\b|\bPAL\b/.test(t)) return "DVD";
  return null;
}

export function getHdrType(hdrInfo: string[], title: string): HdrType {
  const hasDV = hdrInfo.includes("DV");
  const hasHDR = hdrInfo.some((item) => item === "HDR" || item.startsWith("HDR10") || item === "HLG");
  if (hasDV && hasHDR) return "dv+hdr";
  if (hasDV) return "dv";
  if (hasHDR) return "hdr";
  if (/\b10[\s._-]?bit\b/i.test(title)) return "10bit";
  return "sdr";
}

export function parseTorrentTitle(title: string, resolution?: string | null): ParsedTorrentCandidate {
  const detectedResolution = resolution ?? title.match(RESOLUTION_REGEX)?.[1] ?? null;
  const parsed: ParsedTorrentCandidate = {
    title,
    searchName: extractSearchName(title),
    resolution: normalizeResolution(detectedResolution),
    qualityType: extractQualityType(title),
    codec: extractCodec(title),
    hdr: extractHdr(title),
    source: extractSource(title)
  };
  const year = extractYear(title);
  if (year) parsed.year = year;
  return parsed;
}
