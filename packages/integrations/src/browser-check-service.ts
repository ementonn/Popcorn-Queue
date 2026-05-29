import {
  MemoryCacheStore,
  evaluatePtpCoexistence,
  makePtpCacheKey,
  normalizeImdbId,
  parseTorrentTitle,
  type BrowserCheckResult,
  type CacheStore,
  type NormalizedPtpResponse,
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
      try {
        results.push(await this.check(candidate, options));
      } catch (error) {
        results.push(this.errorResult(candidate, error));
      }
    }
    return results;
  }

  async check(candidate: TorrentCandidate, options: { bypassCache?: boolean } = {}): Promise<BrowserCheckResult> {
    const parsed = parseTorrentTitle(candidate.title, candidate.resolution);
    const normalizedImdbId = normalizeImdbId(candidate.imdbId);
    const normalizedCandidate = { ...candidate, imdbId: normalizedImdbId };
    const cacheKey = makePtpCacheKey(normalizedCandidate);
    const cacheEntry = await this.cache.get(cacheKey);

    if (cacheEntry && !options.bypassCache) {
      return this.resultFromData(normalizedCandidate, parsed, cacheEntry.data, {
        key: cacheKey,
        hit: true,
        cachedAt: new Date(cacheEntry.createdAt).toISOString()
      });
    }

    try {
      await this.waitForRateLimit();
      const searchParams: { title: string; imdbId?: string | null; searchName: string; year?: string } = {
        title: candidate.title,
        imdbId: normalizedImdbId,
        searchName: parsed.searchName
      };
      if (parsed.year) searchParams.year = parsed.year;
      const data = await this.ptp.searchByCandidate(searchParams);
      await this.cache.set(cacheKey, data);

      return this.resultFromData(normalizedCandidate, parsed, data, {
        key: cacheKey,
        hit: false
      });
    } catch (error) {
      if (cacheEntry) {
        return this.resultFromData(normalizedCandidate, parsed, cacheEntry.data, {
          key: cacheKey,
          hit: true,
          cachedAt: new Date(cacheEntry.createdAt).toISOString(),
          fallback: true,
          error: errorMessage(error)
        });
      }
      return this.errorResult(normalizedCandidate, error);
    }
  }

  async invalidate(candidate: Pick<TorrentCandidate, "title" | "imdbId">): Promise<string> {
    const key = makePtpCacheKey(candidate);
    await this.cache.delete(key);
    return key;
  }

  private async waitForRateLimit(): Promise<void> {
    const delay = this.config.requestDelayMs ?? 2000;
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < delay) {
      await new Promise((resolve) => setTimeout(resolve, delay - elapsed));
    }
    this.lastRequestAt = Date.now();
  }

  private resultFromData(
    candidate: TorrentCandidate,
    parsed: ReturnType<typeof parseTorrentTitle>,
    data: NormalizedPtpResponse,
    cache: Omit<BrowserCheckResult["cache"], "policy">
  ): BrowserCheckResult {
    return {
      candidate,
      parsed,
      decision: evaluatePtpCoexistence(data, parsed, normalizeImdbId(candidate.imdbId)),
      cache: {
        ...cache,
        policy: "permanent"
      }
    };
  }

  private errorResult(candidate: TorrentCandidate, error: unknown): BrowserCheckResult {
    const parsed = parseTorrentTitle(candidate.title, candidate.resolution);
    const normalizedCandidate = { ...candidate, imdbId: normalizeImdbId(candidate.imdbId) };
    const message = errorMessage(error);
    return {
      candidate: normalizedCandidate,
      parsed,
      decision: {
        status: "error",
        movieFound: false,
        reason: message,
        confidence: "low"
      },
      cache: {
        key: makePtpCacheKey(normalizedCandidate),
        hit: false,
        policy: "permanent",
        error: message
      }
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown PTP check error");
}
