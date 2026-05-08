export type JobState = "created" | "preparing" | "review" | "uploading" | "paused" | "failed" | "done" | "needs_reseed" | "seeding";
export type UploadReadiness = "blocked" | "missing_evidence" | "ready";

export interface ReviewGate {
  id: string;
  severity: "blocker" | "warning" | "info";
  status: "open" | "resolved";
  title: string;
  detail: string;
}

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

export interface ApiJob {
  id: string;
  state: JobState;
  phase: string;
  createdAt?: string;
  updatedAt: string;
  uploadReadiness: UploadReadiness;
  humanStep: string;
  source: {
    site?: string;
    url?: string;
    title?: string;
  };
  candidate?: {
    site: string;
    title: string;
    imdbId?: string | null;
    sourceTorrentId?: string | null;
  };
  checkResult?: {
    decision?: {
      status: string;
      reason: string;
      ptpUrl?: string | null;
    };
  };
  artifacts?: {
    mediaFiles?: string[];
    screenshots?: string[];
    mediainfo?: string;
    bdinfo?: string;
    releaseName?: string;
    description?: string;
    duplicateResult?: string;
    uploadTorrent?: string;
    qbReady?: boolean;
  };
  torrent?: {
    filename: string;
    bytes: number;
    contentType?: string;
  };
  downloadStatus?: DownloadStatus;
  uploadPlan?: {
    releaseName?: {
      generated: string;
      group: string | null;
      container: string | null;
      warnings: string[];
    };
    screenshots?: {
      count: number;
      imageHosts: string[];
      toneMapHint: string;
    };
    torrentReuse?: {
      strategy: string;
      preservePieceHashes: boolean;
      reason: string;
    };
    metadata?: {
      imdbId: string | null;
      providers: Array<{ provider: string; status: string; reason: string }>;
      tags: string[];
    };
    media?: {
      container: string | null;
      discType: string;
      audio: { codecs: string[]; languages: string[]; commentaryLikely: boolean };
      subtitles: { languages: string[]; embeddedLikely: boolean };
      trumpableChecks: string[];
    };
    reviewGates: ReviewGate[];
  };
  phases?: Array<{
    phase: string;
    state: string;
    retryCount: number;
    message: string;
  }>;
  events?: Array<{
    id: string;
    at: string;
    level: "info" | "warn" | "error";
    message: string;
  }>;
}

export interface HealthInfo {
  ok: boolean;
  ptpConfigured: boolean;
  browserTokenConfigured: boolean;
  publicWebUrl?: string;
  publicApiUrl?: string;
  external?: {
    imageHost?: string;
    imgbbConfigured?: boolean;
    ptpImgConfigured?: boolean;
    torrentClientConfigured?: boolean;
    externalToolsEnabled?: boolean;
  };
}

export interface JobLogResponse {
  lines: string[];
}

export interface GlobalLogResponse {
  api: string[];
  worker: string[];
}
