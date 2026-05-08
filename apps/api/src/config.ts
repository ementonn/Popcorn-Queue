import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ApiConfig {
  host: string;
  port: number;
  browserToken: string;
  allowedOrigins: string[];
  publicWebUrl: string;
  publicApiUrl: string;
  ptp: {
    apiUser: string;
    apiKey: string;
    username: string;
    password: string;
    baseUrl: string;
    userAgent: string;
    requestDelayMs: number;
    announceUrl: string;
    cookieFile: string;
  };
  integrations: {
    imageHost: string;
    imgbbApiKey: string;
    tmdbApiKey: string;
    ptpImgApiKey: string;
    qbittorrentUrl: string;
    qbittorrentUsername: string;
    qbittorrentPassword: string;
    qbittorrentTags: string[];
    qbittorrentCategory: string;
    qbittorrentContentLayout: string;
    runExternalTools: boolean;
    ffmpegBin: string;
    mediainfoBin: string;
    oxipngBin: string;
    workDir: string;
    outputDir: string;
  };
}

type EnvMap = NodeJS.ProcessEnv | Record<string, string | undefined>;

const DEFAULT_PTP_BASE_URL = "https://passthepopcorn.me/torrents.php";

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
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

export function loadEnvFile(filePath: string, env: EnvMap = process.env): boolean {
  if (!existsSync(filePath)) return false;

  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || env[key] !== undefined) continue;

    env[key] = decodeEnvValue(normalized.slice(equalsIndex + 1));
  }

  return true;
}

export function loadLocalEnv(env: EnvMap = process.env): string[] {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../..", ".env")
  ];
  const loaded: string[] = [];
  const seen = new Set<string>();

  for (const filePath of candidates) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (loadEnvFile(filePath, env)) loaded.push(filePath);
  }

  return loaded;
}

export function loadConfig(env = process.env): ApiConfig {
  if (env === process.env) loadLocalEnv(env);
  const port = readNumber(env.POPCORN_QUEUE_PORT, 3500);

  return {
    host: env.POPCORN_QUEUE_HOST ?? "0.0.0.0",
    port,
    browserToken: env.POPCORN_QUEUE_BROWSER_TOKEN ?? "",
    allowedOrigins: splitCsv(env.POPCORN_QUEUE_ALLOWED_ORIGINS),
    publicWebUrl: env.POPCORN_QUEUE_WEB_URL ?? "http://localhost:5173",
    publicApiUrl: env.POPCORN_QUEUE_API_URL ?? `http://localhost:${port}`,
    ptp: {
      apiUser: env.PTP_API_USER ?? "",
      apiKey: env.PTP_API_KEY ?? "",
      username: env.PTP_USERNAME ?? "",
      password: env.PTP_PASSWORD ?? "",
      baseUrl: env.PTP_BASE_URL ?? DEFAULT_PTP_BASE_URL,
      userAgent: env.PTP_USER_AGENT ?? "Popcorn Queue/0.1",
      requestDelayMs: readNumber(env.PTP_REQUEST_DELAY_MS, 2000),
      announceUrl: env.PTP_ANNOUNCE_URL ?? "",
      cookieFile: env.PTP_COOKIE_FILE ?? ""
    },
    integrations: {
      imageHost: env.POPCORN_QUEUE_IMAGE_HOST ?? "",
      imgbbApiKey: env.IMGBB_API_KEY ?? "",
      tmdbApiKey: env.TMDB_API_KEY ?? "",
      ptpImgApiKey: env.PTPIMG_API_KEY ?? "",
      qbittorrentUrl: env.QBITTORRENT_URL ?? "",
      qbittorrentUsername: env.QBITTORRENT_USERNAME ?? "",
      qbittorrentPassword: env.QBITTORRENT_PASSWORD ?? "",
      qbittorrentTags: splitCsv(env.QBITTORRENT_TAGS),
      qbittorrentCategory: env.QBITTORRENT_CATEGORY ?? "",
      qbittorrentContentLayout: env.QBITTORRENT_CONTENT_LAYOUT ?? "",
      runExternalTools: readBoolean(env.POPCORN_QUEUE_RUN_EXTERNAL_TOOLS),
      ffmpegBin: env.FFMPEG_BIN ?? "ffmpeg",
      mediainfoBin: env.MEDIAINFO_BIN ?? "mediainfo",
      oxipngBin: env.OXIPNG_BIN ?? "oxipng",
      workDir: env.POPCORN_QUEUE_WORK_DIR ?? "./data/work",
      outputDir: env.POPCORN_QUEUE_OUTPUT_DIR ?? "./data/output"
    }
  };
}
