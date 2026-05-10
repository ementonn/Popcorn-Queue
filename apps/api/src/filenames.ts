import path from "node:path";

export function repairUtf8Mojibake(value: string): string {
  const suspicious = /[\u0080-\u009f]|(?:Ã.|Â.|â[\u0080-\u00bf])/.test(value);
  if (!suspicious) return value;
  const repaired = Buffer.from(value, "latin1").toString("utf8");
  return repaired && !repaired.includes("\uFFFD") ? repaired : value;
}

export function normalizeUploadedFilename(value: string | null | undefined, fallback = "source.torrent"): string {
  const basename = repairUtf8Mojibake(path.basename((value ?? "").trim()));
  return basename || fallback;
}
