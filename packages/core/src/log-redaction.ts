import { redactSecretUrl } from "./rss.js";

export const REDACTED_TEXT = "[redacted]";

const SECRET_KEYS = new Set([
  "authorization",
  "cookie",
  "apikey",
  "password",
  "token",
  "browsertoken",
  "imgbbapikey",
  "ptpimgapikey",
  "qbittorrentpassword"
]);

function normalizeSecretKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKey(key: string): boolean {
  const normalizedKey = normalizeSecretKey(key);
  return (
    SECRET_KEYS.has(normalizedKey) ||
    normalizedKey.includes("cookie") ||
    normalizedKey.endsWith("apikey") ||
    normalizedKey.endsWith("password") ||
    normalizedKey.endsWith("token")
  );
}

export function redactForLog<T>(value: T): T {
  if (typeof value === "string") return redactSecretUrl(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactForLog(item)) as T;
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSecretKey(key) ? REDACTED_TEXT : redactForLog(item);
  }
  return output as T;
}
