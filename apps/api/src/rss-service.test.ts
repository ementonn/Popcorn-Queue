import { rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { BrowserCheckResult, TorrentCandidate } from "@popcorn-queue/core";
import { JobRepository } from "./jobs.js";
import {
  MemoryRssItemRepository,
  MemoryRssSettingsRepository,
  MemoryRssSubscriptionRepository,
  RssService
} from "./rss-service.js";

function checkResult(candidate: TorrentCandidate, status: BrowserCheckResult["decision"]["status"]): BrowserCheckResult {
  return {
    candidate,
    parsed: null,
    decision: {
      status,
      movieFound: status !== "not_found",
      reason: `${status} reason`,
      confidence: "high",
      ...(status === "open"
        ? {
            movie: { GroupId: "123", Title: "Movie", Year: "2026", ImdbId: "tt1234567", Torrents: [] },
            ptpUrl: "https://passthepopcorn.me/torrents.php?id=123"
          }
        : {})
    },
    cache: { key: "ptp:test", hit: false, policy: "permanent" }
  };
}

const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel><title>Test</title>
  <item>
    <title><![CDATA[[电影 / Movies]Movie 2026 1080p WEB-DL x265-GROUP[中文字幕][1.00 GB]]]></title>
    <link>https://zmpt.cc/details.php?id=1</link>
    <description><![CDATA[https://www.imdb.com/title/tt1234567/]]></description>
    <enclosure url="https://zmpt.cc/download.php?downhash=secret" length="1000" />
    <guid>guid-open</guid>
    <pubDate>Sun, 31 May 2026 00:00:00 +0800</pubDate>
  </item>
  <item>
    <title><![CDATA[[电影 / Movies]Bystander 2025 2160p WEB-DL 60Fps x265-GROUP[中字][2.00 GB]]]></title>
    <link>https://zmpt.cc/details.php?id=2</link>
    <enclosure url="https://zmpt.cc/download.php?downhash=secret2" length="2000" />
    <guid>guid-filtered</guid>
  </item>
</channel></rss>`;

describe("RSS service", () => {
  it("refreshes a subscription into proposals and filtered history without downloading", async () => {
    const subscriptions = new MemoryRssSubscriptionRepository();
    const items = new MemoryRssItemRepository();
    const settings = new MemoryRssSettingsRepository();
    const subscription = await subscriptions.create({
      name: "ZMPT",
      site: "zmweb",
      feedUrl: "https://zmpt.cc/rss?passkey=secret",
      enabled: true,
      filter: { excludeKeywords: ["60Fps"] }
    });
    const fetchImpl = vi.fn(async () => new Response(rssXml, { status: 200 }));
    const duplicateChecks = {
      check: vi.fn(async (candidate: TorrentCandidate) => checkResult(candidate, "open"))
    };
    const service = new RssService({
      settings,
      subscriptions,
      items,
      duplicateChecks,
      jobRepository: new JobRepository([]),
      dataRoot: "/tmp/rss-service-test",
      fetchImpl,
      enqueuePreparation: vi.fn()
    });

    const result = await service.refreshSubscription(subscription.id);

    expect(result).toMatchObject({ fetched: 2, proposals: 1, filtered: 1 });
    expect(fetchImpl).toHaveBeenCalledWith("https://zmpt.cc/rss?passkey=secret");
    expect(duplicateChecks.check).toHaveBeenCalledTimes(1);
    const all = await items.list(subscription.id, {});
    expect(all.items.map((item) => item.status).sort()).toEqual(["filtered", "proposal"]);
    expect(all.items.find((item) => item.status === "proposal")?.ptpTarget).toMatchObject({
      groupId: "123",
      displayTitle: "Movie [2026]",
      ptpUrl: "https://passthepopcorn.me/torrents.php?id=123",
      resolvedFrom: "imdb"
    });
  });

  it("keeps full duplicate items in All Items but not Proposals", async () => {
    const subscriptions = new MemoryRssSubscriptionRepository();
    const items = new MemoryRssItemRepository();
    const subscription = await subscriptions.create({ name: "ZMPT", site: "zmweb", feedUrl: "https://zmpt.cc/rss", enabled: true, filter: {} });
    const service = new RssService({
      settings: new MemoryRssSettingsRepository(),
      subscriptions,
      items,
      duplicateChecks: { check: vi.fn(async (candidate: TorrentCandidate) => checkResult(candidate, "full")) },
      jobRepository: new JobRepository([]),
      dataRoot: "/tmp/rss-service-test",
      fetchImpl: vi.fn(async () => new Response(rssXml, { status: 200 })),
      enqueuePreparation: vi.fn()
    });

    await service.refreshSubscription(subscription.id);

    expect((await items.list(subscription.id, { view: "proposals" })).items).toHaveLength(0);
    expect((await items.list(subscription.id, {})).items.some((item) => item.status === "duplicate_full")).toBe(true);
  });

  it("downloads a torrent and creates a preparing job only when a proposal is accepted", async () => {
    const subscriptions = new MemoryRssSubscriptionRepository();
    const items = new MemoryRssItemRepository();
    const jobRepository = new JobRepository([]);
    const dataRoot = "/tmp/rss-service-accept-test";
    await rm(dataRoot, { recursive: true, force: true });
    const subscription = await subscriptions.create({ name: "ZMPT", site: "zmweb", feedUrl: "https://zmpt.cc/rss", enabled: true, filter: {} });
    const item = await items.upsertFromRefresh({
      subscriptionId: subscription.id,
      guid: "guid-1",
      sourceUrl: "https://zmpt.cc/details.php?id=1",
      downloadUrl: "https://zmpt.cc/download.php?downhash=secret",
      title: "Movie.2026.1080p.WEB-DL.x265-GROUP",
      subtitle: "中字",
      size: 123,
      publishedAt: null,
      status: "proposal",
      filterReason: null,
      checkResult: checkResult({ site: "zmweb", title: "Movie.2026.1080p.WEB-DL.x265-GROUP" }, "open"),
      ptpTarget: { groupId: "123", displayTitle: "Movie [2026]", year: "2026", imdbId: "tt1234567", ptpUrl: "https://passthepopcorn.me/torrents.php?id=123", resolvedFrom: "imdb" },
      raw: {}
    });
    const enqueuePreparation = vi.fn();
    const service = new RssService({
      settings: new MemoryRssSettingsRepository(),
      subscriptions,
      items,
      duplicateChecks: { check: vi.fn() },
      jobRepository,
      dataRoot,
      fetchImpl: vi.fn(async () => new Response("d4:infod6:lengthi1eee", { status: 200, headers: { "content-type": "application/x-bittorrent" } })),
      enqueuePreparation
    });

    const result = await service.acceptItem(item.id);

    expect(result.item.status).toBe("accepted");
    expect(result.item.acceptedJobId).toBe(result.job.id);
    expect(result.job.state).toBe("preparing");
    expect(result.job.source).toMatchObject({ site: "rss", url: "https://zmpt.cc/details.php?id=1", title: item.title, subtitle: "中字" });
    expect(result.job.source.ptpTarget).toMatchObject({ groupId: "123" });
    expect(enqueuePreparation).toHaveBeenCalledWith(result.job.id);
    await rm(dataRoot, { recursive: true, force: true });
  });
});
