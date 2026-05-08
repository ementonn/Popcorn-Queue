import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCacheStore, makePtpCacheKey } from "./index.js";

describe("PTP cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores PTP lookups permanently by default", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));

    const cache = new MemoryCacheStore<{ movies: [] }>();
    const entry = await cache.set("ptp:imdb:tt0816692", { movies: [] });

    vi.setSystemTime(new Date("2027-05-08T00:00:00.000Z"));

    await expect(cache.get("ptp:imdb:tt0816692")).resolves.toMatchObject({
      key: "ptp:imdb:tt0816692",
      data: { movies: [] }
    });
  });

  it("prefers IMDb keys and falls back to normalized title/year keys", () => {
    expect(makePtpCacheKey({ imdbId: "https://www.imdb.com/title/tt0816692/", title: "Interstellar.2014.1080p.BluRay.x264" })).toBe(
      "ptp:imdb:tt0816692"
    );
    expect(makePtpCacheKey({ imdbId: null, title: "Interstellar.2014.1080p.BluRay.x264" })).toBe("ptp:search:interstellar|2014");
  });
});
