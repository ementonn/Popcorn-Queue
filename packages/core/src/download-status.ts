export interface DownloadStatus {
  client: "qbittorrent" | "not-configured" | string;
  infoHash: string | null;
  state: string;
  progress: number | null;
  downloaded: number | null;
  size: number | null;
  amountLeft: number | null;
  downloadSpeed: number | null;
  uploadSpeed: number | null;
  eta: number | null;
  seeds: number | null;
  peers: number | null;
  savePath: string | null;
  contentPath: string | null;
  lastUpdatedAt: string;
  error: string | null;
}

const COMPLETE_STATES = new Set(["uploading", "stalledUP", "queuedUP", "pausedUP", "forcedUP", "checkingUP"]);

export function isDownloadComplete(status: Pick<DownloadStatus, "progress" | "state">): boolean {
  return status.progress === 1 || COMPLETE_STATES.has(status.state);
}

export function createDownloadStatus(input: Omit<DownloadStatus, "lastUpdatedAt"> & { lastUpdatedAt?: string }): DownloadStatus {
  return {
    ...input,
    lastUpdatedAt: input.lastUpdatedAt ?? new Date().toISOString()
  };
}

export function createDownloadErrorStatus(input: {
  client: DownloadStatus["client"];
  infoHash: string | null;
  state?: string;
  error: string;
  lastUpdatedAt?: string;
}): DownloadStatus {
  return createDownloadStatus({
    client: input.client,
    infoHash: input.infoHash,
    state: input.state ?? "error",
    progress: null,
    downloaded: null,
    size: null,
    amountLeft: null,
    downloadSpeed: null,
    uploadSpeed: null,
    eta: null,
    seeds: null,
    peers: null,
    savePath: null,
    contentPath: null,
    error: input.error,
    ...(input.lastUpdatedAt ? { lastUpdatedAt: input.lastUpdatedAt } : {})
  });
}
