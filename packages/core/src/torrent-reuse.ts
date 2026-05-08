import type { TorrentCandidate } from "./types.js";

export interface TorrentReusePlan {
  strategy: "reuse-source-torrent" | "search-generic-cache" | "hash-from-content";
  canReuseImmediately: boolean;
  sourceTorrentId: string | null;
  reason: string;
  preservePieceHashes: boolean;
}

export function buildTorrentReusePlan(candidate: TorrentCandidate, torrentBytes?: number): TorrentReusePlan {
  if (candidate.sourceTorrentId) {
    return {
      strategy: "reuse-source-torrent",
      canReuseImmediately: true,
      sourceTorrentId: candidate.sourceTorrentId,
      reason: "Browser bridge supplied a source torrent ID, so the worker can try to preserve piece hashes first.",
      preservePieceHashes: true
    };
  }

  if (torrentBytes && torrentBytes > 0) {
    return {
      strategy: "search-generic-cache",
      canReuseImmediately: true,
      sourceTorrentId: null,
      reason: "A source .torrent was uploaded; compare info hash and file layout before rehashing.",
      preservePieceHashes: true
    };
  }

  return {
    strategy: "hash-from-content",
    canReuseImmediately: false,
    sourceTorrentId: null,
    reason: "No reusable source torrent is available yet.",
    preservePieceHashes: false
  };
}
