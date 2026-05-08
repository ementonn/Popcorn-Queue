export const REDACTED_TEXT = "[redacted]";

const SECRET_KEYS = new Set([
  "authorization",
  "cookie",
  "apiKey",
  "api_key",
  "password",
  "token",
  "browserToken",
  "imgbbApiKey",
  "ptpImgApiKey",
  "qbittorrentPassword"
]);

export function redactForLog<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactForLog(item)) as T;
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEYS.has(key) ? REDACTED_TEXT : redactForLog(item);
  }
  return output as T;
}
