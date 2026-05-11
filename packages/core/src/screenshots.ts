import type { ParsedTorrentCandidate } from "./types.js";

export interface ScreenshotTimestamp {
  index: number;
  seconds: number;
  label: string;
  reason: string;
}

export interface ScreenshotPlan {
  count: number;
  timestamps: ScreenshotTimestamp[];
  optimizer: "oxipng";
  imageHosts: string[];
  toneMapHint: "bt2020" | "bt709" | "unknown";
}

export interface ScreenshotPlanOptions {
  imageHosts?: string[];
  count?: number;
  rng?: () => number;
}

const DEFAULT_SCREENSHOT_COUNT = 4;
const DEFAULT_IMAGE_HOSTS = ["ptpimg", "imgbb", "imgbox", "freeimage"];

function formatTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hh = Math.floor(whole / 3600).toString().padStart(2, "0");
  const mm = Math.floor((whole % 3600) / 60).toString().padStart(2, "0");
  const ss = (whole % 60).toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function buildScreenshotPlan(parsed: ParsedTorrentCandidate, durationSeconds = 7200, options: ScreenshotPlanOptions = {}): ScreenshotPlan {
  const count = Math.max(1, Math.floor(options.count ?? DEFAULT_SCREENSHOT_COUNT));
  const safeDuration = durationSeconds > 0 && durationSeconds < 900 ? durationSeconds : Math.max(durationSeconds, 900);
  const maxTimestamp = Math.max(0, Math.floor(safeDuration) - 1);
  const rng = options.rng ?? Math.random;
  const usableStart = safeDuration < 60 ? 0 : Math.floor(safeDuration * 0.1);
  const usableEnd = safeDuration < 60 ? maxTimestamp : Math.max(usableStart, Math.min(maxTimestamp, Math.floor(safeDuration * 0.9)));
  const usableLength = Math.max(1, usableEnd - usableStart + 1);
  const timestamps = Array.from({ length: count }, (_, index) => {
    const windowStart = usableStart + Math.floor((usableLength * index) / count);
    const windowEnd = usableStart + Math.floor((usableLength * (index + 1)) / count) - 1;
    const windowLength = Math.max(1, windowEnd - windowStart + 1);
    const randomOffset = Math.min(windowLength - 1, Math.floor(Math.max(0, Math.min(0.999999, rng())) * windowLength));
    const seconds = Math.max(0, Math.min(maxTimestamp, windowStart + randomOffset));
    return {
      index: index + 1,
      seconds,
      label: formatTimestamp(seconds),
      reason: index === 0 ? "Avoids opening credits." : index === count - 1 ? "Avoids end credits." : "Randomized content coverage."
    };
  });

  return {
    count: timestamps.length,
    timestamps,
    optimizer: "oxipng",
    imageHosts: options.imageHosts?.length ? options.imageHosts : DEFAULT_IMAGE_HOSTS,
    toneMapHint: parsed.hdr.length > 0 || parsed.resolution === "2160p" ? "bt2020" : parsed.source === "DVD" ? "unknown" : "bt709"
  };
}
