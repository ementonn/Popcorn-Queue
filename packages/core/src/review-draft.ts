import type { UploadPlan } from "./upload-plan.js";
import type { BrowserCheckResult, TorrentCandidate } from "./types.js";

export interface PtpArtistDraft {
  name: string;
  importance: "1" | "2" | "3" | "4" | "5" | "";
}

export interface ReviewDraft {
  releaseName: string;
  description: string;
  groupId: string | null;
  type: string;
  codec: string;
  container: string;
  resolution: string;
  source: string;
  otherSource?: string;
  otherCodec?: string;
  otherContainer?: string;
  otherResolutionWidth?: string;
  otherResolutionHeight?: string;
  imdb?: string;
  title?: string;
  year?: string;
  image?: string;
  trailer?: string;
  tags?: string;
  synopsis?: string;
  remaster?: boolean;
  remasterYear: string;
  remasterTitle: string;
  special?: string;
  subtitles: string[];
  trumpable: string[];
  scene: boolean;
  personalRip: boolean;
  internal: boolean;
  uploadToken?: string;
  artists?: PtpArtistDraft[];
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

export function normalizeCodec(value: string | null): string {
  if (!value) return "Other";
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact === "H265" || compact === "X265" || compact === "HEVC") return "H.265";
  if (compact === "H264" || compact === "X264" || compact === "AVC") return "H.264";
  return value;
}

export function normalizeSource(value: string | null): string {
  if (!value) return "Other";
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact === "web" || compact === "webdl" || compact === "webrip") return "WEB";
  if (compact === "bluray" || compact === "bdrip" || compact === "bdr" || compact === "bdremux") return "Blu-ray";
  if (compact === "dvd") return "DVD";
  if (compact === "hddvd") return "HD-DVD";
  if (compact === "hdtv") return "HDTV";
  if (compact === "tv") return "TV";
  if (compact === "vhs") return "VHS";
  return value;
}

export function normalizeContainer(value: string | null | undefined): string {
  if (!value) return "MKV";
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact === "mkv" || compact === "matroska") return "MKV";
  if (compact === "mp4" || compact === "mpeg4") return "MP4";
  if (compact === "avi") return "AVI";
  if (compact === "mpg" || compact === "mpeg") return "MPG";
  if (compact === "iso") return "ISO";
  if (compact === "vobifo") return "VOB IFO";
  if (compact === "m2ts" || compact === "mts") return "m2ts";
  return value.toUpperCase();
}

function groupIdFromResult(checkResult: BrowserCheckResult | undefined): string | null {
  if (checkResult?.decision.movie?.GroupId) return checkResult.decision.movie.GroupId;
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

const SUBTITLE_LABEL_TO_ID = new Map([
  ["english", "3"],
  ["chinese", "14"],
  ["mandarin", "14"],
  ["no subtitles", "44"],
  ["nosubtitles", "44"]
]);

const TRUMPABLE_LABEL_TO_ID = new Map([
  ["no english subtitles", "14"],
  ["noenglishsubtitles", "14"],
  ["hardcoded subtitles", "4"],
  ["hardcoded subs", "4"],
  ["hardcodedsubs", "4"]
]);

function mappedId(value: string, mapping: Map<string, string>): string {
  if (/^\d+$/.test(value)) return value;
  const lower = value.toLowerCase();
  return mapping.get(lower) ?? mapping.get(lower.replace(/[^a-z0-9]/g, "")) ?? value;
}

function stringList(value: unknown, mapping?: Map<string, string>): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean).map((item) => (mapping ? mappedId(item, mapping) : item)))];
}

function artistImportance(value: unknown): PtpArtistDraft["importance"] {
  const next = stringValue(value);
  return next === "1" || next === "2" || next === "3" || next === "4" || next === "5" ? next : "";
}

function artistList(value: unknown): PtpArtistDraft[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const source = item as Record<string, unknown>;
      const name = stringValue(source.name);
      if (!name) return null;
      return { name, importance: artistImportance(source.importance) };
    })
    .filter((item): item is PtpArtistDraft => item !== null);
}

export function buildReviewDraft(input: BuildReviewDraftInput): ReviewDraft {
  const parsed = input.uploadPlan.parsed;
  const movie = input.checkResult?.decision.movie;
  return {
    releaseName: input.artifacts.releaseName ?? input.uploadPlan.releaseName.generated,
    description: input.artifacts.description ?? "",
    groupId: groupIdFromResult(input.checkResult),
    type: "Feature Film",
    codec: normalizeCodec(parsed.codec),
    container: normalizeContainer(input.uploadPlan.media.container),
    resolution: parsed.resolution ?? input.candidate.resolution ?? "Other",
    source: normalizeSource(parsed.source),
    imdb: input.candidate.imdbId ?? movie?.ImdbId ?? "",
    title: parsed.searchName || movie?.Title || movie?.Name || parsed.title || "",
    year: parsed.year ?? movie?.Year ?? "",
    image: "",
    trailer: "",
    tags: "",
    synopsis: "",
    remaster: false,
    remasterYear: "",
    remasterTitle: "",
    special: "",
    subtitles: stringList(input.uploadPlan.media.subtitles.languages, SUBTITLE_LABEL_TO_ID) ?? [],
    trumpable: [],
    scene: input.uploadPlan.scene.status === "likely_scene",
    personalRip: false,
    internal: false,
    uploadToken: "",
    artists: []
  };
}

export function mergeReviewDraft(current: ReviewDraft, patch: ReviewDraftPatch): ReviewDraft {
  const next: ReviewDraft = { ...current };
  for (const key of [
    "releaseName",
    "description",
    "type",
    "codec",
    "container",
    "resolution",
    "source",
    "otherSource",
    "otherCodec",
    "otherContainer",
    "otherResolutionWidth",
    "otherResolutionHeight",
    "imdb",
    "title",
    "year",
    "image",
    "trailer",
    "tags",
    "synopsis",
    "remasterYear",
    "remasterTitle",
    "special",
    "uploadToken"
  ] as const) {
    const value = stringValue(patch[key]);
    if (value !== undefined) next[key] = value;
  }
  const groupId = nullableString(patch.groupId);
  if (groupId !== undefined) next.groupId = groupId;
  const subtitles = stringList(patch.subtitles, SUBTITLE_LABEL_TO_ID);
  if (subtitles !== undefined) next.subtitles = subtitles;
  const trumpable = stringList(patch.trumpable, TRUMPABLE_LABEL_TO_ID);
  if (trumpable !== undefined) next.trumpable = trumpable;
  const artists = artistList(patch.artists);
  if (artists !== undefined) next.artists = artists;
  for (const key of ["scene", "personalRip", "internal", "remaster"] as const) {
    const value = booleanValue(patch[key]);
    if (value !== undefined) next[key] = value;
  }
  return next;
}
