import type { CacheEntry, CacheStore, TorrentCandidate } from "./types.js";
import { extractSearchName, extractYear, normalizeImdbId } from "./parse.js";

export function makePtpCacheKey(candidate: Pick<TorrentCandidate, "imdbId" | "title">): string {
  const imdb = normalizeImdbId(candidate.imdbId);
  if (imdb) return `ptp:imdb:${imdb}`;
  const name = extractSearchName(candidate.title).toLowerCase();
  const year = extractYear(candidate.title) ?? "";
  return `ptp:search:${name}|${year}`;
}

export class MemoryCacheStore<T> implements CacheStore<T> {
  private readonly items = new Map<string, CacheEntry<T>>();

  async get(key: string): Promise<CacheEntry<T> | null> {
    const entry = this.items.get(key);
    if (!entry) return null;
    return entry;
  }

  async set(key: string, data: T): Promise<CacheEntry<T>> {
    const now = Date.now();
    const entry: CacheEntry<T> = {
      key,
      data,
      createdAt: now
    };
    this.items.set(key, entry);
    return entry;
  }

  async delete(key: string): Promise<void> {
    this.items.delete(key);
  }
}
