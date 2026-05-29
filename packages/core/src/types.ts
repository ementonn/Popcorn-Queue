export type SourceSite = "tjupt" | "pter" | "mteam" | "hdb" | "hhclub" | "unknown";

export type Resolution =
  | "NTSC"
  | "PAL"
  | "480p"
  | "480i"
  | "576p"
  | "576i"
  | "720p"
  | "1080i"
  | "1080p"
  | "2160p"
  | "other";

export type CandidateQuality = "Encode" | "WEB-DL" | "Remux" | "Untouched";
export type HdrType = "dv+hdr" | "dv" | "hdr" | "10bit" | "sdr";

export interface TorrentCandidate {
  id?: string;
  site: SourceSite;
  title: string;
  imdbId?: string | null;
  resolution?: string | null;
  sourceUrl?: string | null;
  downloadUrl?: string | null;
  sourceTorrentId?: string | null;
}

export interface ParsedTorrentCandidate {
  title: string;
  searchName: string;
  year?: string;
  resolution: Resolution | null;
  qualityType: CandidateQuality;
  codec: string | null;
  hdr: string[];
  source: string | null;
}

export interface PtpTorrent {
  Id?: string;
  Quality?: string;
  Source?: string;
  Codec?: string;
  Resolution?: string;
  Size?: string | number;
  ReleaseName?: string;
  RemasterTitle?: string;
  Trumpable?: boolean | string | number;
  Seeders?: string | number;
  LastActive?: string;
  FilePath?: string;
  FileList?: Array<{ Path?: string; Size?: string | number }>;
}

export interface PtpMovie {
  GroupId?: string;
  Title?: string;
  Name?: string;
  Year?: string;
  ImdbId?: string;
  Torrents?: PtpTorrent[];
}

export interface NormalizedPtpResponse {
  page?: string;
  totalResults?: number;
  movies: PtpMovie[];
  raw?: unknown;
}

export type RuleStatus =
  | "open"
  | "full"
  | "trumpable"
  | "coexist"
  | "not_found"
  | "no_torrents"
  | "review"
  | "skip"
  | "error";

export interface ClassifiedPtpTorrent {
  res: string | null;
  quality: string;
  codec: string;
  source: string;
  hasHDR: boolean;
  hasDV: boolean;
  isRemux: boolean;
  isUntouched: boolean;
  isWebDL: boolean;
  isEncode: boolean;
  isBluray: boolean;
  hdrType: HdrType;
  remaster: string;
  trumpable: boolean;
  seeders: number;
  lastActive?: string;
  size: number;
  releaseName?: string;
}

export interface RuleDecision {
  status: RuleStatus;
  movieFound: boolean;
  movie?: PtpMovie;
  ptpUrl?: string | null;
  slotType?: string;
  used?: number;
  max?: number;
  existing?: ClassifiedPtpTorrent[];
  reason: string;
  confidence: "high" | "medium" | "low";
}

export interface BrowserCheckResult {
  candidate: TorrentCandidate;
  parsed: ParsedTorrentCandidate | null;
  decision: RuleDecision;
  cache: {
    key: string;
    hit: boolean;
    policy: "permanent";
    cachedAt?: string;
    fallback?: boolean;
    error?: string;
  };
}

export interface CacheEntry<T> {
  key: string;
  data: T;
  createdAt: number;
}

export interface CacheStore<T> {
  get(key: string): Promise<CacheEntry<T> | null>;
  set(key: string, data: T): Promise<CacheEntry<T>>;
  delete(key: string): Promise<void>;
}
