import type { ParsedTorrentCandidate, TorrentCandidate } from "./types.js";

export interface ReleaseNamePlan {
  generated: string;
  group: string | null;
  container: string | null;
  components: {
    name: string;
    year: string | null;
    resolution: string | null;
    source: string | null;
    codec: string | null;
    hdr: string[];
  };
  warnings: string[];
}

const CONTAINER_REGEX = /\.(mkv|mp4|avi|m2ts|ts|iso)$/i;

export function extractReleaseGroup(title: string): string | null {
  const filename = title.split(/[\\/]/).at(-1) ?? title;
  const withoutExtension = filename.replace(CONTAINER_REGEX, "");
  const match = withoutExtension.match(/-([A-Za-z0-9]+)$/);
  return match?.[1] ?? null;
}

export function extractContainer(title: string): string | null {
  const match = title.match(CONTAINER_REGEX) ?? title.match(/\b(MKV|MP4|AVI|M2TS|ISO)\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function dotJoin(parts: Array<string | null | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.trim().replace(/\s+/g, ".").replace(/\.+/g, "."))
    .join(".");
}

function normalizeSource(source: string | null): string | null {
  if (!source) return null;
  if (source === "Blu-ray") return "BluRay";
  return source.replace(/[\s_-]+/g, "-");
}

export function buildReleaseNamePlan(candidate: TorrentCandidate, parsed: ParsedTorrentCandidate): ReleaseNamePlan {
  const group = extractReleaseGroup(candidate.title);
  const container = extractContainer(candidate.title);
  const name = parsed.searchName || candidate.title;
  const source = normalizeSource(parsed.source);
  const generatedBase = dotJoin([
    name,
    parsed.year,
    parsed.resolution,
    source,
    parsed.codec,
    ...parsed.hdr
  ]);
  const generated = group ? `${generatedBase}-${group}` : generatedBase;
  const warnings: string[] = [];

  if (!parsed.year) warnings.push("Release year was not detected.");
  if (!parsed.resolution) warnings.push("Resolution was not detected.");
  if (!parsed.codec) warnings.push("Codec was not detected.");
  if (!group) warnings.push("Release group was not detected.");
  if (container === "MP4") warnings.push("MP4 container needs remux review for PTP.");

  return {
    generated,
    group,
    container,
    components: {
      name,
      year: parsed.year ?? null,
      resolution: parsed.resolution,
      source,
      codec: parsed.codec,
      hdr: parsed.hdr
    },
    warnings
  };
}
