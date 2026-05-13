import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path, { resolve } from "node:path";
import { loadConfig, loadEnvFile, type ApiConfig } from "./config.js";

export type SettingFieldType = "text" | "number" | "boolean" | "password";
export type SettingGroup = "Browser" | "PTP" | "Image Hosts" | "qBittorrent" | "Tools";

export interface SettingFieldDefinition {
  key: string;
  label: string;
  group: SettingGroup;
  type: SettingFieldType;
  secret?: boolean;
  description?: string;
}

export interface SettingField extends SettingFieldDefinition {
  value: string;
  configured: boolean;
}

export interface SettingsResponse {
  envPath: string;
  fields: SettingField[];
}

export interface SaveSettingsInput {
  values?: Record<string, string | null>;
}

export interface SaveSettingsResult extends SettingsResponse {
  saved: true;
  reloaded: true;
  restartRequired: false;
}

const HOT_SETTING_FIELDS: SettingFieldDefinition[] = [
  { key: "POPCORN_QUEUE_BROWSER_TOKEN", label: "Browser token", group: "Browser", type: "password", secret: true },
  { key: "PTP_API_USER", label: "PTP API user", group: "PTP", type: "password", secret: true },
  { key: "PTP_API_KEY", label: "PTP API key", group: "PTP", type: "password", secret: true },
  { key: "PTP_BASE_URL", label: "PTP base URL", group: "PTP", type: "text" },
  { key: "PTP_USER_AGENT", label: "PTP user agent", group: "PTP", type: "text" },
  { key: "PTP_REQUEST_DELAY_MS", label: "PTP request delay", group: "PTP", type: "number" },
  { key: "PTP_ANNOUNCE_URL", label: "PTP announce URL", group: "PTP", type: "password", secret: true },
  { key: "PTP_USERNAME", label: "PTP username", group: "PTP", type: "text" },
  { key: "PTP_PASSWORD", label: "PTP password", group: "PTP", type: "password", secret: true },
  { key: "PTP_COOKIE_FILE", label: "PTP cookie file", group: "PTP", type: "text" },
  { key: "POPCORN_QUEUE_IMAGE_HOST", label: "Primary image host", group: "Image Hosts", type: "text" },
  { key: "TMDB_API_KEY", label: "TMDb API key", group: "Image Hosts", type: "password", secret: true },
  { key: "PTPIMG_API_KEY", label: "PTPImg API key", group: "Image Hosts", type: "password", secret: true },
  { key: "IMGBB_API_KEY", label: "ImgBB API key", group: "Image Hosts", type: "password", secret: true },
  { key: "QBITTORRENT_URL", label: "qBittorrent URL", group: "qBittorrent", type: "text" },
  { key: "QBITTORRENT_USERNAME", label: "qBittorrent username", group: "qBittorrent", type: "text" },
  { key: "QBITTORRENT_PASSWORD", label: "qBittorrent password", group: "qBittorrent", type: "password", secret: true },
  { key: "QBITTORRENT_TAGS", label: "qBittorrent tags", group: "qBittorrent", type: "text" },
  { key: "QBITTORRENT_CATEGORY", label: "qBittorrent category", group: "qBittorrent", type: "text" },
  { key: "QBITTORRENT_CONTENT_LAYOUT", label: "qBittorrent content layout", group: "qBittorrent", type: "text" },
  { key: "QBITTORRENT_DOWNLOAD_WAIT_MS", label: "Download wait", group: "qBittorrent", type: "number" },
  { key: "QBITTORRENT_DOWNLOAD_POLL_MS", label: "Download poll interval", group: "qBittorrent", type: "number" },
  { key: "POPCORN_QUEUE_RUN_EXTERNAL_TOOLS", label: "Run external tools", group: "Tools", type: "boolean" },
  { key: "FFMPEG_BIN", label: "ffmpeg", group: "Tools", type: "text" },
  { key: "MEDIAINFO_BIN", label: "MediaInfo", group: "Tools", type: "text" },
  { key: "MKVMERGE_BIN", label: "mkvmerge", group: "Tools", type: "text" },
  { key: "OXIPNG_BIN", label: "oxipng", group: "Tools", type: "text" }
];

const HOT_SETTING_KEYS = new Set(HOT_SETTING_FIELDS.map((field) => field.key));

function projectRoot(): string {
  const cwd = process.cwd();
  const segments = cwd.split(/[\\/]/);
  if (segments.at(-2) === "apps" && segments.at(-1) === "api") return resolve(cwd, "../..");
  return cwd;
}

export function defaultSettingsEnvPath(): string {
  return resolve(projectRoot(), ".env");
}

function decodeEnvValue(rawValue: string): string {
  let value = rawValue.trim();
  if (!value) return "";

  const quote = value[0];
  const last = value[value.length - 1];
  if ((quote === "\"" || quote === "'") && last === quote) {
    value = value.slice(1, -1);
    return quote === "\"" ? value.replace(/\\n/g, "\n").replace(/\\"/g, "\"").replace(/\\\\/g, "\\") : value;
  }

  const commentIndex = value.indexOf(" #");
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trim();
}

function parseEnvValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) values.set(key, decodeEnvValue(normalized.slice(equalsIndex + 1)));
  }
  return values;
}

function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"")}"`;
}

function mergeEnvText(baseText: string, updates: Map<string, string>): string {
  const seen = new Set<string>();
  const lines = baseText.split(/\r?\n/).map((rawLine) => {
    const normalized = rawLine.trim().startsWith("export ") ? rawLine.trim().slice(7).trim() : rawLine.trim();
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) return rawLine;
    const key = normalized.slice(0, equalsIndex).trim();
    if (!updates.has(key)) return rawLine;
    seen.add(key);
    return `${key}=${formatEnvValue(updates.get(key) ?? "")}`;
  });

  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  for (const field of HOT_SETTING_FIELDS) {
    if (!updates.has(field.key) || seen.has(field.key)) continue;
    lines.push(`${field.key}=${formatEnvValue(updates.get(field.key) ?? "")}`);
  }
  return `${lines.join("\n")}\n`;
}

function configValue(config: ApiConfig, key: string): string {
  const values: Record<string, string> = {
    POPCORN_QUEUE_BROWSER_TOKEN: config.browserToken,
    PTP_API_USER: config.ptp.apiUser,
    PTP_API_KEY: config.ptp.apiKey,
    PTP_BASE_URL: config.ptp.baseUrl,
    PTP_USER_AGENT: config.ptp.userAgent,
    PTP_REQUEST_DELAY_MS: String(config.ptp.requestDelayMs),
    PTP_ANNOUNCE_URL: config.ptp.announceUrl,
    PTP_USERNAME: config.ptp.username,
    PTP_PASSWORD: config.ptp.password,
    PTP_COOKIE_FILE: config.ptp.cookieFile,
    POPCORN_QUEUE_IMAGE_HOST: config.integrations.imageHost,
    TMDB_API_KEY: config.integrations.tmdbApiKey,
    PTPIMG_API_KEY: config.integrations.ptpImgApiKey,
    IMGBB_API_KEY: config.integrations.imgbbApiKey,
    QBITTORRENT_URL: config.integrations.qbittorrentUrl,
    QBITTORRENT_USERNAME: config.integrations.qbittorrentUsername,
    QBITTORRENT_PASSWORD: config.integrations.qbittorrentPassword,
    QBITTORRENT_TAGS: config.integrations.qbittorrentTags.join(","),
    QBITTORRENT_CATEGORY: config.integrations.qbittorrentCategory,
    QBITTORRENT_CONTENT_LAYOUT: config.integrations.qbittorrentContentLayout,
    QBITTORRENT_DOWNLOAD_WAIT_MS: String(config.integrations.qbittorrentDownloadWaitMs),
    QBITTORRENT_DOWNLOAD_POLL_MS: String(config.integrations.qbittorrentDownloadPollMs),
    POPCORN_QUEUE_RUN_EXTERNAL_TOOLS: String(config.integrations.runExternalTools),
    FFMPEG_BIN: config.integrations.ffmpegBin,
    MEDIAINFO_BIN: config.integrations.mediainfoBin,
    MKVMERGE_BIN: config.integrations.mkvmergeBin,
    OXIPNG_BIN: config.integrations.oxipngBin
  };
  return values[key] ?? "";
}

export function settingsResponse(envPath: string, config: ApiConfig): SettingsResponse {
  return {
    envPath,
    fields: HOT_SETTING_FIELDS.map((definition) => {
      const rawValue = configValue(config, definition.key);
      const secret = Boolean(definition.secret);
      return {
        ...definition,
        secret,
        value: secret ? "" : rawValue,
        configured: rawValue.length > 0
      };
    })
  };
}

export async function saveSettingsEnv(envPath: string, input: SaveSettingsInput): Promise<void> {
  const values = input.values ?? {};
  const unknown = Object.keys(values).filter((key) => !HOT_SETTING_KEYS.has(key));
  if (unknown.length) throw new Error(`Unsupported settings: ${unknown.join(", ")}`);

  const existingText = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
  const merged = parseEnvValues(existingText);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    merged.set(key, value ?? "");
  }

  await mkdir(path.dirname(envPath), { recursive: true });
  if (existsSync(envPath)) await copyFile(envPath, `${envPath}.backup`);
  const tempPath = `${envPath}.${process.pid}.tmp`;
  await writeFile(tempPath, mergeEnvText(existingText, merged), "utf8");
  await rename(tempPath, envPath);
}

export function loadConfigFromEnvPath(envPath: string): ApiConfig {
  const env = { ...process.env };
  loadEnvFile(envPath, env, { override: true });
  return loadConfig(env);
}
