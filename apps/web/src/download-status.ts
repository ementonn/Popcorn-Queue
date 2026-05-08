import type { DownloadStatus } from "./types.js";

const COMPLETE_STATES = new Set(["uploading", "stalledUP", "queuedUP", "pausedUP", "forcedUP", "checkingUP"]);

const STATE_LABELS: Record<string, string> = {
  downloading: "Downloading",
  metaDL: "Fetching metadata",
  forcedDL: "Downloading",
  queuedDL: "Queued",
  pausedDL: "Paused",
  stalledDL: "Stalled",
  checkingDL: "Checking",
  checkingUP: "Checking",
  uploading: "Downloaded",
  stalledUP: "Downloaded",
  queuedUP: "Downloaded",
  pausedUP: "Downloaded",
  forcedUP: "Downloaded",
  unavailable: "Unavailable",
  missing: "Missing",
  error: "Error"
};

export function isDownloaded(status: DownloadStatus | null | undefined): boolean {
  return Boolean(status && (status.progress === 1 || COMPLETE_STATES.has(status.state)));
}

export function downloadProgress(status: DownloadStatus | null | undefined): number | null {
  if (!status || typeof status.progress !== "number" || !Number.isFinite(status.progress)) return null;
  return Math.max(0, Math.min(1, status.progress));
}

export function formatPercent(status: DownloadStatus | null | undefined): string | null {
  const progress = downloadProgress(status);
  return progress === null ? null : `${Math.round(progress * 100)}%`;
}

export function formatByteSize(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const precision = index === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[index]}`;
}

export function formatSpeed(value: number | null | undefined): string | null {
  const size = formatByteSize(value);
  return size ? `${size}/s` : null;
}

export function formatEta(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const totalMinutes = Math.max(1, Math.round(value / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}m`;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function downloadStateLabel(status: DownloadStatus | null | undefined): string {
  if (!status) return "Waiting";
  if (status.error) return "Error";
  return STATE_LABELS[status.state] ?? titleCaseState(status.state);
}

export function downloadSummary(status: DownloadStatus | null | undefined): string {
  const label = downloadStateLabel(status);
  const percent = formatPercent(status);
  if (!status || status.error || isDownloaded(status) || !percent) return label;
  return `${label} (${percent})`;
}

export function downloadDetail(status: DownloadStatus | null | undefined): string {
  if (!status) return "No qB snapshot yet";
  if (status.error) return status.error;

  const parts = [formatPercent(status)];
  if (!isDownloaded(status)) {
    parts.push(formatSpeed(status.downloadSpeed));
    parts.push(formatEta(status.eta));
  }
  if (status.seeds !== null || status.peers !== null) {
    parts.push(`${status.seeds ?? 0} seed${status.seeds === 1 ? "" : "s"} / ${status.peers ?? 0} peer${status.peers === 1 ? "" : "s"}`);
  }
  return parts.filter((part): part is string => Boolean(part)).join(" - ") || status.state;
}

export function downloadedBytesLabel(status: DownloadStatus | null | undefined): string {
  if (!status) return "unknown";
  const downloaded = formatByteSize(status.downloaded);
  const size = formatByteSize(status.size);
  const remaining = formatByteSize(status.amountLeft);
  if (downloaded && size) return `${downloaded} / ${size}`;
  if (remaining) return `${remaining} remaining`;
  return downloaded ?? size ?? "unknown";
}

function titleCaseState(state: string): string {
  return state
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
