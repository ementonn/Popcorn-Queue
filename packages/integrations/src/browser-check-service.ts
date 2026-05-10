import {
  MemoryCacheStore,
  evaluatePtpCoexistence,
  makePtpCacheKey,
  normalizeImdbId,
  parseTorrentTitle,
  type BrowserCheckResult,
  type CacheStore,
  type NormalizedPtpResponse,
  type PtpMovie,
  type TorrentCandidate
} from "@popcorn-queue/core";
import type { PtpClient } from "./ptp/client.js";

export interface BrowserCheckServiceConfig {
  requestDelayMs?: number;
}

export class BrowserCheckService {
  private lastRequestAt = 0;

  constructor(
    private readonly ptp: PtpClient,
    private readonly cache: CacheStore<NormalizedPtpResponse> = new MemoryCacheStore<NormalizedPtpResponse>(),
    private readonly config: BrowserCheckServiceConfig = {}
  ) {}

  async checkBatch(candidates: TorrentCandidate[], options: { bypassCache?: boolean } = {}): Promise<BrowserCheckResult[]> {
    const results: BrowserCheckResult[] = [];
    for (const candidate of candidates) {
      results.push(await this.check(candidate, options));
    }
    return results;
  }

  async check(candidate: TorrentCandidate, options: { bypassCache?: boolean } = {}): Promise<BrowserCheckResult> {
    const parsed = parseTorrentTitle(candidate.title, candidate.resolution);
    const normalizedImdbId = normalizeImdbId(candidate.imdbId);
    const cacheKey = makePtpCacheKey({ ...candidate, imdbId: normalizedImdbId });
    let hit = false;
    let cachedAt: string | undefined;
    let data: NormalizedPtpResponse | null = null;

    if (!options.bypassCache) {
      const cacheEntry = await this.cache.get(cacheKey);
      if (cacheEntry) {
        hit = true;
        cachedAt = new Date(cacheEntry.createdAt).toISOString();
        data = cacheEntry.data;
      }
    }

    if (!data) {
      await this.waitForRateLimit();
      const searchParams: { title: string; imdbId?: string | null; searchName: string; year?: string } = {
        title: candidate.title,
        imdbId: normalizedImdbId,
        searchName: parsed.searchName
      };
      if (parsed.year) searchParams.year = parsed.year;
      data = await this.ptp.searchByCandidate(searchParams);
      await this.cache.set(cacheKey, data);
    }

    const enrichedData = await this.enrichMissingMovieDetails(data);
    if (enrichedData !== data) {
      data = enrichedData;
      await this.cache.set(cacheKey, data);
    }

    const cacheInfo: BrowserCheckResult["cache"] = {
      key: cacheKey,
      hit,
      policy: "permanent"
    };
    if (cachedAt) cacheInfo.cachedAt = cachedAt;

    return {
      candidate: { ...candidate, imdbId: normalizedImdbId },
      parsed,
      decision: evaluatePtpCoexistence(data, parsed, normalizedImdbId),
      cache: cacheInfo
    };
  }

  async invalidate(candidate: Pick<TorrentCandidate, "title" | "imdbId">): Promise<string> {
    const key = makePtpCacheKey(candidate);
    await this.cache.delete(key);
    return key;
  }

  private async enrichMissingMovieDetails(data: NormalizedPtpResponse): Promise<NormalizedPtpResponse> {
    const movie = data.movies[0];
    if (!movie?.GroupId || movie.ImdbId) return data;

    await this.waitForRateLimit();
    const details = await this.ptp.getGroup(movie.GroupId);
    const detail = details.movies.find((item) => item.GroupId === movie.GroupId) ?? details.movies[0];
    if (!detail?.ImdbId) return data;

    const movies = [...data.movies];
    movies[0] = mergeMovieDetails(movie, detail);
    return { ...data, movies };
  }

  private async waitForRateLimit(): Promise<void> {
    const delay = this.config.requestDelayMs ?? 2000;
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < delay) {
      await new Promise((resolve) => setTimeout(resolve, delay - elapsed));
    }
    this.lastRequestAt = Date.now();
  }
}

function mergeMovieDetails(movie: PtpMovie, detail: PtpMovie): PtpMovie {
  const merged: PtpMovie = {
    ...movie,
    ...detail
  };
  if (!detail.Torrents?.length && movie.Torrents) merged.Torrents = movie.Torrents;
  return merged;
}
