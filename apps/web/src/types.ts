export type JobState = "created" | "preparing" | "review" | "uploading" | "paused" | "failed" | "done" | "needs_reseed" | "seeding";
export type UploadReadiness = "blocked" | "missing_evidence" | "ready";

export interface AuthSessionInfo {
  authRequired: boolean;
  authenticated: boolean;
  username: string | null;
}

export interface ManualIntakePtpTarget {
  groupId: string;
  displayTitle: string;
  year: string | null;
  imdbId: string | null;
  ptpUrl: string;
}

export interface MediaPathValidationResult {
  ok: boolean;
  mediaPath: string;
  basename: string;
  kind: "file" | "directory" | "missing" | "relative" | "unsupported" | "unreadable";
  size: number | null;
  error: string | null;
  warning: string | null;
}

export interface PtpMovieSearchCandidate extends ManualIntakePtpTarget {
  title: string;
  raw: unknown;
}

export interface PtpMovieSearchResponse {
  query: string;
  parsedYear: string | null;
  results: PtpMovieSearchCandidate[];
}

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

export interface ReviewDraft {
  releaseName: string;
  description: string;
  groupId: string | null;
  type: string;
  codec: string;
  container: string;
  resolution: string;
  source: string;
  otherSource?: string;
  otherCodec?: string;
  otherContainer?: string;
  otherResolutionWidth?: string;
  otherResolutionHeight?: string;
  imdb?: string;
  title?: string;
  year?: string;
  image?: string;
  trailer?: string;
  tags?: string;
  synopsis?: string;
  remaster?: boolean;
  remasterYear: string;
  remasterTitle: string;
  special?: string;
  subtitles: string[];
  trumpable: string[];
  scene: boolean;
  personalRip: boolean;
  internal: boolean;
  uploadToken?: string;
  artists?: Array<{ name: string; importance: "1" | "2" | "3" | "4" | "5" | "" }>;
}

export type ReviewDraftPatch = Partial<ReviewDraft>;

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
    mediaPath?: string;
    torrentUrl?: string;
    ptpTarget?: ManualIntakePtpTarget;
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
    mediaInfoText?: string;
    mediaInfoJson?: string;
    bdinfo?: string;
    releaseName?: string;
    description?: string;
    duplicateResult?: string;
    uploadTorrent?: string;
    qbReady?: boolean;
    reviewWarnings?: string[];
    ptpUrl?: string;
    ptpGroupId?: string;
    ptpTorrentId?: string;
  };
  reviewDraft?: ReviewDraft;
  torrent?: {
    filename: string;
    bytes: number;
    contentType?: string;
    filePath?: string;
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

export type DiagnosticCheckTarget = "qbittorrent" | "ptp" | "image-host" | "tools";
export type DiagnosticCheckStatus = "not_checked" | "ok" | "configured" | "missing" | "failed" | "disabled";
export type DiagnosticToolName = "ffmpeg" | "mediainfo" | "mkvmerge" | "oxipng";

export interface DiagnosticTool {
  tool: DiagnosticToolName;
  command: string;
  available: boolean;
  version: string | null;
  location: string | null;
  error: string | null;
}

export interface DiagnosticCheckResult {
  target: DiagnosticCheckTarget;
  configured: boolean;
  status: DiagnosticCheckStatus;
  detail: string;
  checkedAt?: string;
  tools?: Record<DiagnosticToolName, DiagnosticTool>;
}

export interface DiagnosticsInfo {
  system: {
    api: "online" | "offline" | string;
    persistence: string;
    publicWebUrl?: string;
    publicApiUrl?: string;
    browserBridgeConfigured: boolean;
    ptpApiConfigured: boolean;
    externalToolsEnabled: boolean;
  };
  integrations: {
    qbittorrent: Omit<DiagnosticCheckResult, "target">;
    ptp: Omit<DiagnosticCheckResult, "target">;
    imageHost: Omit<DiagnosticCheckResult, "target">;
    tools: Omit<DiagnosticCheckResult, "target">;
  };
  queue: {
    total: number;
    preparing: number;
    review: number;
    failed: number;
    done: number;
    paused: number;
    uploading: number;
    seeding: number;
    needsReseed: number;
    stuck: Array<{ id: string; state: string; phase: string; updatedAt: string; title: string }>;
    recentFailures: Array<{ id: string; message: string; title: string }>;
  };
  tools: Record<DiagnosticToolName, DiagnosticTool>;
  storage: {
    dataRoot: string;
    databasePath: string | null;
    jobCount: number;
    cacheEntries: number | null;
    databaseBytes: number | null;
    dataRootFreeBytes: number | null;
  };
  logs: {
    api: string[];
  };
}

export interface JobLogResponse {
  lines: string[];
}

export interface GlobalLogResponse {
  api: string[];
}
