import { XMLParser } from "fast-xml-parser";
import { parseTorrentTitle } from "./parse.js";
import type { RuleStatus, SourceSite, TorrentCandidate } from "./types.js";

export type RssItemStatus = "proposal" | "filtered" | "duplicate_full" | "duplicate_skip" | "check_error" | "ignored" | "accepted";

export interface ParsedRssItem {
  site: SourceSite;
  title: string;
  subtitle: string | null;
  sourceUrl: string | null;
  downloadUrl: string | null;
  guid: string | null;
  size: number | null;
  publishedAt: string | null;
  imdbId: string | null;
  sourceTorrentId: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedRssFeed {
  title: string | null;
  items: ParsedRssItem[];
}

export interface RssFilterConfig {
  includeKeywords?: string[];
  excludeKeywords?: string[];
  allowedResolutions?: string[];
  allowedCodecs?: string[];
  allowedGroups?: string[];
  blockedGroups?: string[];
  minSize?: number | null;
  maxSize?: number | null;
}

const SECRET_QUERY_KEYS = new Set(["passkey", "downhash", "auth", "token", "key", "apikey", "api_key"]);

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).join(" ").trim();
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && "#text" in (value as Record<string, unknown>)) {
    return text((value as Record<string, unknown>)["#text"]);
  }
  return String(value).trim();
}

function attr(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const direct = (value as Record<string, unknown>)[`@_${key}`] ?? (value as Record<string, unknown>)[key];
  return direct === undefined || direct === null ? null : String(direct);
}

function stripBracketPrefix(title: string): { title: string; subtitle: string | null } {
  const match = title.match(/^\[[^\]]+\]([^\[]+)(?:\[([^\]]+)\])?(?:\[[^\]]+\])?$/);
  if (!match) return { title: title.trim(), subtitle: null };
  return { title: match[1]?.trim() ?? title.trim(), subtitle: match[2]?.trim() || null };
}

function extractImdbId(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const match = value?.match(/tt\d{7,9}/i);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

function sourceTorrentIdFromUrl(sourceUrl: string | null): string | null {
  if (!sourceUrl) return null;
  try {
    return new URL(sourceUrl).searchParams.get("id");
  } catch {
    return sourceUrl.match(/[?&]id=(\d+)/i)?.[1] ?? null;
  }
}

function parseDate(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function redactSecretUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return value.replace(/([?&](?:passkey|downhash|auth|token|key|api_key|apikey)=)[^&\s]+/gi, "$1[redacted]");
  }
}

export function parseRssFeed(xml: string, options: { site?: SourceSite } = {}): ParsedRssFeed {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    cdataPropName: "#text",
    textNodeName: "#text",
    trimValues: true
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const channel = ((parsed.rss as Record<string, unknown> | undefined)?.channel ?? parsed.channel ?? {}) as Record<string, unknown>;
  const items = asArray(channel.item).map((item): ParsedRssItem => {
    const record = item as Record<string, unknown>;
    const rawTitle = text(record.title);
    const titleParts = stripBracketPrefix(rawTitle);
    const sourceUrl = text(record.link) || null;
    const enclosure = record.enclosure;
    const downloadUrl = attr(enclosure, "url");
    const size = Number(attr(enclosure, "length"));
    const description = text(record.description);
    return {
      site: options.site ?? "unknown",
      title: titleParts.title,
      subtitle: titleParts.subtitle,
      sourceUrl,
      downloadUrl,
      guid: text(record.guid) || null,
      size: Number.isFinite(size) ? size : null,
      publishedAt: parseDate(text(record.pubDate)),
      imdbId: extractImdbId(description, rawTitle),
      sourceTorrentId: sourceTorrentIdFromUrl(sourceUrl),
      raw: {
        title: rawTitle,
        sourceUrl,
        size: Number.isFinite(size) ? size : null,
        publishedAt: text(record.pubDate) || null
      }
    };
  });
  return { title: text(channel.title) || null, items };
}

function hasKeyword(title: string, keyword: string): boolean {
  return title.toLowerCase().includes(keyword.toLowerCase());
}

function releaseGroup(title: string): string | null {
  return title.match(/-([A-Za-z0-9]+)$/)?.[1] ?? null;
}

export function evaluateRssFilter(item: Pick<ParsedRssItem, "title" | "size">, filter: RssFilterConfig = {}): { passed: boolean; reason: string | null } {
  for (const keyword of filter.excludeKeywords ?? []) {
    if (keyword && hasKeyword(item.title, keyword)) return { passed: false, reason: `Title matched excluded keyword: ${keyword}` };
  }
  for (const keyword of filter.includeKeywords ?? []) {
    if (keyword && !hasKeyword(item.title, keyword)) return { passed: false, reason: `Title did not match required keyword: ${keyword}` };
  }
  const parsed = parseTorrentTitle(item.title);
  if (filter.allowedResolutions?.length && (!parsed.resolution || !filter.allowedResolutions.includes(parsed.resolution))) {
    return { passed: false, reason: `Resolution is not allowed: ${parsed.resolution ?? "unknown"}` };
  }
  if (filter.allowedCodecs?.length && (!parsed.codec || !filter.allowedCodecs.some((codec) => parsed.codec?.toLowerCase() === codec.toLowerCase()))) {
    return { passed: false, reason: `Codec is not allowed: ${parsed.codec ?? "unknown"}` };
  }
  const group = releaseGroup(item.title);
  if (filter.allowedGroups?.length && (!group || !filter.allowedGroups.some((allowed) => allowed.toLowerCase() === group.toLowerCase()))) {
    return { passed: false, reason: `Release group is not allowed: ${group ?? "unknown"}` };
  }
  if (filter.blockedGroups?.some((blocked) => group?.toLowerCase() === blocked.toLowerCase())) {
    return { passed: false, reason: `Release group is blocked: ${group}` };
  }
  if (filter.minSize !== undefined && filter.minSize !== null && (item.size ?? 0) < filter.minSize) {
    return { passed: false, reason: `Size is below minimum: ${item.size ?? 0}` };
  }
  if (filter.maxSize !== undefined && filter.maxSize !== null && (item.size ?? 0) > filter.maxSize) {
    return { passed: false, reason: `Size is above maximum: ${item.size ?? 0}` };
  }
  return { passed: true, reason: null };
}

export function rssItemStatusFromDecision(status: RuleStatus): RssItemStatus {
  if (status === "open" || status === "not_found" || status === "no_torrents" || status === "coexist" || status === "trumpable") return "proposal";
  if (status === "full") return "duplicate_full";
  if (status === "skip" || status === "review") return "duplicate_skip";
  return "check_error";
}

export function rssItemToTorrentCandidate(item: ParsedRssItem): TorrentCandidate {
  return {
    site: item.site,
    title: item.title,
    ...(item.subtitle ? { subtitle: item.subtitle } : {}),
    ...(item.imdbId ? { imdbId: item.imdbId } : {}),
    ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
    ...(item.downloadUrl ? { downloadUrl: item.downloadUrl } : {}),
    ...(item.sourceTorrentId ? { sourceTorrentId: item.sourceTorrentId } : {})
  };
}
