import type { UploadPlan } from "./upload-plan.js";
import type { BrowserCheckResult, TorrentCandidate } from "./types.js";
import { detectMediaFeatures } from "./media-features.js";
import { PTP_SUBTITLE_OPTIONS } from "./ptp-options.js";

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
    mediaInfoJson?: string;
    mediaFeatureSuggestions?: string[];
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

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SUBTITLE_ALIASES = [
  ["en", "3"],
  ["eng", "3"],
  ["english cc", "3"],
  ["english sdh", "3"],
  ["en forced", "50"],
  ["english forced", "50"],
  ["en intertitles", "51"],
  ["english intertitles", "51"],
  ["es", "4"],
  ["spa", "4"],
  ["fr", "5"],
  ["fre", "5"],
  ["de", "6"],
  ["ger", "6"],
  ["ru", "7"],
  ["rus", "7"],
  ["ja", "8"],
  ["jpn", "8"],
  ["nl", "9"],
  ["dut", "9"],
  ["da", "10"],
  ["dan", "10"],
  ["sv", "11"],
  ["swe", "11"],
  ["no", "12"],
  ["nor", "12"],
  ["ro", "13"],
  ["rum", "13"],
  ["zh", "14"],
  ["chi", "14"],
  ["mandarin", "14"],
  ["chinese simplified", "14"],
  ["chinese traditional", "14"],
  ["fi", "15"],
  ["fin", "15"],
  ["it", "16"],
  ["ita", "16"],
  ["pl", "17"],
  ["pol", "17"],
  ["tr", "18"],
  ["tur", "18"],
  ["ko", "19"],
  ["kor", "19"],
  ["th", "20"],
  ["tha", "20"],
  ["pt", "21"],
  ["por", "21"],
  ["ar", "22"],
  ["ara", "22"],
  ["hr", "23"],
  ["hrv", "23"],
  ["scr", "23"],
  ["hu", "24"],
  ["hun", "24"],
  ["vi", "25"],
  ["vie", "25"],
  ["el", "26"],
  ["gre", "26"],
  ["is", "28"],
  ["ice", "28"],
  ["bg", "29"],
  ["bul", "29"],
  ["cs", "30"],
  ["cz", "30"],
  ["cze", "30"],
  ["sr", "31"],
  ["srp", "31"],
  ["scc", "31"],
  ["uk", "34"],
  ["ukr", "34"],
  ["lv", "37"],
  ["lav", "37"],
  ["et", "38"],
  ["est", "38"],
  ["lt", "39"],
  ["lit", "39"],
  ["he", "40"],
  ["heb", "40"],
  ["hi", "41"],
  ["hin", "41"],
  ["sk", "42"],
  ["slo", "42"],
  ["sl", "43"],
  ["slv", "43"],
  ["id", "47"],
  ["ind", "47"],
  ["pt br", "49"],
  ["pt-br", "49"],
  ["brazilian", "49"],
  ["brazilian portuguese", "49"],
  ["portuguese br", "49"],
  ["portuguese-br", "49"],
  ["fa", "52"],
  ["far", "52"],
  ["persian", "52"],
  ["ms", "54"],
  ["my", "54"],
  ["mys", "54"],
  ["cy", "55"],
  ["wel", "55"]
] as const;

const SUBTITLE_LABEL_TO_ID = new Map<string, string>();
for (const option of PTP_SUBTITLE_OPTIONS) {
  SUBTITLE_LABEL_TO_ID.set(option.label.toLowerCase(), option.id);
  SUBTITLE_LABEL_TO_ID.set(compactKey(option.label), option.id);
}
for (const [label, id] of SUBTITLE_ALIASES) {
  SUBTITLE_LABEL_TO_ID.set(label.toLowerCase(), id);
  SUBTITLE_LABEL_TO_ID.set(compactKey(label), id);
}

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
  return mapping.get(lower) ?? mapping.get(compactKey(lower)) ?? value;
}

function stringList(value: unknown, mapping?: Map<string, string>): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean).map((item) => (mapping ? mappedId(item, mapping) : item)))];
}

export function mergeSlashSeparated(left: string, right: string): string {
  return [
    ...new Set(
      [...left.split("/"), ...right.split("/")]
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ].join(" / ");
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
  const remasterTitle = mergeSlashSeparated("", (input.artifacts.mediaFeatureSuggestions ?? []).join(" / "));
  const subtitleFeatures = detectMediaFeatures({
    mediaInfoJson: input.artifacts.mediaInfoJson,
    releaseName: input.artifacts.releaseName ?? input.uploadPlan.releaseName.generated,
    sourceSubtitleInfo: input.candidate.subtitleInfo,
    sourceSubtitle: input.candidate.subtitle
  }).subtitleFeatures;
  const trumpable = [
    subtitleFeatures.noEnglishLikely ? "14" : "",
    subtitleFeatures.hardcodedLikely ? "4" : ""
  ].filter(Boolean);
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
    remaster: Boolean(remasterTitle),
    remasterYear: "",
    remasterTitle,
    special: "",
    subtitles: stringList(input.uploadPlan.media.subtitles.languages, SUBTITLE_LABEL_TO_ID) ?? [],
    trumpable,
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
