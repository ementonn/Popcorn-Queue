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

const groupDetails: NormalizedPtpResponse = {
  page: "Details",
  movies: [
    {
      GroupId: "323547",
      Title: "Xiao long nv AKA Little Dragon Maiden",
      Year: "2022",
      ImdbId: "tt1234567",
      Torrents: []
    }
  ]
};

function mockPtpClient() {
  return {
    searchByCandidate: vi.fn(async () => titleSearchResult),
    getGroup: vi.fn(async () => groupDetails)
  } as unknown as PtpClient & {
    searchByCandidate: ReturnType<typeof vi.fn>;
    getGroup: ReturnType<typeof vi.fn>;
  };
}

describe("BrowserCheckService", () => {
  it("enriches title-search matches with group details when IMDb is missing", async () => {
    const ptp = mockPtpClient();
    const service = new BrowserCheckService(ptp, new MemoryCacheStore<NormalizedPtpResponse>(), { requestDelayMs: 0 });

    const result = await service.check(candidate);

    expect(ptp.getGroup).toHaveBeenCalledWith("323547");
    expect(result.decision.movie?.ImdbId).toBe("tt1234567");
  });

  it("repairs cached title-search matches that were stored without IMDb", async () => {
    const ptp = mockPtpClient();
    const cache = new MemoryCacheStore<NormalizedPtpResponse>();
    await cache.set("ptp:search:little dragon maiden|2022", titleSearchResult);
    const service = new BrowserCheckService(ptp, cache, { requestDelayMs: 0 });

    const first = await service.check(candidate);
    ptp.getGroup.mockClear();
    const second = await service.check(candidate);

    expect(first.cache.hit).toBe(true);
    expect(first.decision.movie?.ImdbId).toBe("tt1234567");
    expect(second.decision.movie?.ImdbId).toBe("tt1234567");
    expect(ptp.getGroup).not.toHaveBeenCalled();
  });
});
