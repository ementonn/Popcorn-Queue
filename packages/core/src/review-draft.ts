import type { BrowserCheckResult, TorrentCandidate, UploadPlan } from "./index.js";

export interface ReviewDraft {
  releaseName: string;
  description: string;
  groupId: string | null;
  type: string;
  codec: string;
  container: string;
  resolution: string;
  source: string;
  remasterYear: string;
  remasterTitle: string;
  subtitles: string[];
  trumpable: string[];
  scene: boolean;
  personalRip: boolean;
  internal: boolean;
}

export type ReviewDraftPatch = Partial<Record<keyof ReviewDraft, unknown>>;

export interface PtpUploadResult {
  groupId: string;
  torrentId: string;
  ptpUrl: string;
}

export interface BuildReviewDraftInput {
  candidate: TorrentCandidate;
  uploadPlan: UploadPlan;
  artifacts: {
    releaseName?: string;
    description?: string;
    mediainfo?: string;
  };
  checkResult?: BrowserCheckResult;
}

function normalizeCodec(value: string | null): string {
  if (!value) return "Other";
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact === "H265" || compact === "X265" || compact === "HEVC") return "H.265";
  if (compact === "H264" || compact === "X264" || compact === "AVC") return "H.264";
  return value;
}

function normalizeSource(value: string | null): string {
  if (!value) return "Other";
  if (/^web$/i.test(value)) return "WEB-DL";
  return value;
}

function normalizeContainer(value: string | null | undefined): string {
  if (!value) return "MKV";
  return value.toUpperCase();
}

function groupIdFromResult(checkResult: BrowserCheckResult | undefined): string | null {
  const url = checkResult?.decision.ptpUrl;
  if (!url) return null;
  try {
    return new URL(url).searchParams.get("id");
  } catch {
    const match = url.match(/[?&]id=(\d+)/);
    return match?.[1] ?? null;
  }
}

function stringValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "";
  return String(value).trim();
}

function nullableString(value: unknown): string | null | undefined {
  const next = stringValue(value);
  if (next === undefined) return undefined;
  return next || null;
}

function booleanValue(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
}

export function buildReviewDraft(input: BuildReviewDraftInput): ReviewDraft {
  const parsed = input.uploadPlan.parsed;
  return {
    releaseName: input.artifacts.releaseName ?? input.uploadPlan.releaseName.generated,
    description: input.artifacts.description ?? "",
    groupId: groupIdFromResult(input.checkResult),
    type: "Feature Film",
    codec: normalizeCodec(parsed.codec),
    container: normalizeContainer(input.uploadPlan.media.container),
    resolution: parsed.resolution ?? input.candidate.resolution ?? "Other",
    source: normalizeSource(parsed.source),
    remasterYear: "",
    remasterTitle: "",
    subtitles: input.uploadPlan.media.subtitles.languages,
    trumpable: [],
    scene: input.uploadPlan.scene.status === "likely_scene",
    personalRip: false,
    internal: false
  };
}

export function mergeReviewDraft(current: ReviewDraft, patch: ReviewDraftPatch): ReviewDraft {
  const next: ReviewDraft = { ...current };
  for (const key of ["releaseName", "description", "type", "codec", "container", "resolution", "source", "remasterYear", "remasterTitle"] as const) {
    const value = stringValue(patch[key]);
    if (value !== undefined) next[key] = value;
  }
  const groupId = nullableString(patch.groupId);
  if (groupId !== undefined) next.groupId = groupId;
  const subtitles = stringList(patch.subtitles);
  if (subtitles !== undefined) next.subtitles = subtitles;
  const trumpable = stringList(patch.trumpable);
  if (trumpable !== undefined) next.trumpable = trumpable;
  for (const key of ["scene", "personalRip", "internal"] as const) {
    const value = booleanValue(patch[key]);
    if (value !== undefined) next[key] = value;
  }
  return next;
}
