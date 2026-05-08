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
}

const MOVIE_PERCENTAGES = [0.12, 0.22, 0.34, 0.48, 0.62, 0.76];
const EPISODE_PERCENTAGES = [0.18, 0.42, 0.66];
const DEFAULT_IMAGE_HOSTS = ["ptpimg", "imgbb", "imgbox", "freeimage"];

function formatTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hh = Math.floor(whole / 3600).toString().padStart(2, "0");
  const mm = Math.floor((whole % 3600) / 60).toString().padStart(2, "0");
  const ss = (whole % 60).toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function buildScreenshotPlan(parsed: ParsedTorrentCandidate, durationSeconds = 7200, options: ScreenshotPlanOptions = {}): ScreenshotPlan {
  const isEpisode = /\bS\d{2}E\d{2}\b/i.test(parsed.title);
  const percentages = (isEpisode ? EPISODE_PERCENTAGES : MOVIE_PERCENTAGES).slice(0, options.count);
  const safeDuration = durationSeconds > 0 && durationSeconds < 900 ? durationSeconds : Math.max(durationSeconds, 900);
  const timestamps = percentages.map((percentage, index) => {
    const maxTimestamp = Math.max(0, Math.floor(safeDuration) - 1);
    const seconds = Math.min(Math.floor(safeDuration * percentage), maxTimestamp);
    return {
      index: index + 1,
      seconds,
      label: formatTimestamp(seconds),
      reason: index === 0 ? "Avoids opening credits." : index === percentages.length - 1 ? "Avoids end credits." : "Even content coverage."
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
