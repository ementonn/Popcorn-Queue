import { describe, expect, it, vi } from "vitest";
import { MemoryCacheStore, type NormalizedPtpResponse, type TorrentCandidate } from "@popcorn-queue/core";
import { BrowserCheckService } from "./browser-check-service.js";
import type { PtpClient } from "./ptp/client.js";

const candidate: TorrentCandidate = {
  site: "pter",
  title: "Little Dragon Maiden 2022 1080p WEB-DL H265 HDR AAC-PTerWEB",
  imdbId: null,
  resolution: "1080p"
};

const titleSearchResult: NormalizedPtpResponse = {
  movies: [
    {
      GroupId: "323547",
      Title: "Xiao long nv AKA Little Dragon Maiden",
      Year: "2022",
      Torrents: []
    }
  ]
};

function mockPtpClient() {
  return {
    searchByCandidate: vi.fn(async () => titleSearchResult),
    getGroup: vi.fn(async () => {
      throw new Error("getGroup should not be called");
    })
  } as unknown as PtpClient & {
    searchByCandidate: ReturnType<typeof vi.fn>;
    getGroup: ReturnType<typeof vi.fn>;
  };
}

describe("BrowserCheckService", () => {
  it("does not fetch group details just to enrich title-search matches with IMDb", async () => {
    const ptp = mockPtpClient();
    const service = new BrowserCheckService(ptp, new MemoryCacheStore<NormalizedPtpResponse>(), { requestDelayMs: 0 });

    const result = await service.check(candidate);

    expect(ptp.getGroup).not.toHaveBeenCalled();
    expect(result.decision.movie?.GroupId).toBe("323547");
    expect(result.decision.movie?.ImdbId).toBeUndefined();
    expect(result.cache.error).toBeUndefined();
  });

  it("uses cached title-search matches without repairing missing IMDb", async () => {
    const ptp = mockPtpClient();
    const cache = new MemoryCacheStore<NormalizedPtpResponse>();
    await cache.set("ptp:search:little dragon maiden|2022", titleSearchResult);
    const service = new BrowserCheckService(ptp, cache, { requestDelayMs: 0 });

    const first = await service.check(candidate);
    const second = await service.check(candidate);

    expect(first.cache.hit).toBe(true);
    expect(first.decision.movie?.GroupId).toBe("323547");
    expect(first.decision.movie?.ImdbId).toBeUndefined();
    expect(second.decision.movie?.ImdbId).toBeUndefined();
    expect(ptp.getGroup).not.toHaveBeenCalled();
  });

  it("returns cached browser check data when a bypassed live check fails", async () => {
    const ptp = mockPtpClient();
    ptp.searchByCandidate.mockRejectedValue(new Error("PTP rate limit"));
    const cache = new MemoryCacheStore<NormalizedPtpResponse>();
    await cache.set("ptp:search:little dragon maiden|2022", titleSearchResult);
    const service = new BrowserCheckService(ptp, cache, { requestDelayMs: 0 });

    const result = await service.check(candidate, { bypassCache: true });

    expect(result.cache).toMatchObject({
      hit: true,
      fallback: true,
      error: "PTP rate limit"
    });
    expect(result.decision.status).toBe("no_torrents");
  });

  it("does not surface rate limits from skipped detail enrichment on cache hits", async () => {
    const ptp = mockPtpClient();
    ptp.getGroup.mockRejectedValue(new Error("PTP rate limit"));
    const cache = new MemoryCacheStore<NormalizedPtpResponse>();
    await cache.set("ptp:search:little dragon maiden|2022", titleSearchResult);
    const service = new BrowserCheckService(ptp, cache, { requestDelayMs: 0 });

    const result = await service.check(candidate);

    expect(result.cache).toMatchObject({
      hit: true
    });
    expect(result.cache.fallback).toBeUndefined();
    expect(result.cache.error).toBeUndefined();
    expect(result.decision.status).toBe("no_torrents");
    expect(ptp.getGroup).not.toHaveBeenCalled();
  });

  it("returns per-candidate errors in batch checks instead of failing the whole batch", async () => {
    const ptp = mockPtpClient();
    ptp.searchByCandidate.mockRejectedValue(new Error("PTP rate limit"));
    const cache = new MemoryCacheStore<NormalizedPtpResponse>();
    await cache.set("ptp:imdb:tt1234567", titleSearchResult);
    const service = new BrowserCheckService(ptp, cache, { requestDelayMs: 0 });

    const results = await service.checkBatch([
      { ...candidate, title: "Uncached.Movie.2024.1080p.WEB-DL.x264-GROUP" },
      { ...candidate, imdbId: "tt1234567" }
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]?.decision).toMatchObject({
      status: "error",
      reason: "PTP rate limit"
    });
    expect(results[1]?.cache.hit).toBe(true);
  });
});
