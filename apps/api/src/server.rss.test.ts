import { afterEach, describe, expect, it, vi } from "vitest";
import { PtpClient } from "@popcorn-queue/integrations";
import { testConfig, withConfiguredServer } from "./server-test-utils.js";

describe("API RSS routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates subscriptions, saves interval settings, refreshes, and lists proposals/all items", async () => {
    vi.spyOn(PtpClient.prototype, "searchByCandidate").mockResolvedValue({
      movies: [{ GroupId: "123", Title: "Movie", Year: "2026", ImdbId: "tt1234567", Torrents: [] }]
    });
    const config = testConfig();
    const rssXml = `<?xml version="1.0"?><rss><channel><item>
      <title><![CDATA[[电影 / Movies]Movie 2026 1080p WEB-DL x265-GROUP[中字][1 GB]]]></title>
      <link>https://zmpt.cc/details.php?id=1</link>
      <description><![CDATA[https://www.imdb.com/title/tt1234567/]]></description>
      <enclosure url="https://zmpt.cc/download.php?downhash=secret" length="1000" />
      <guid>guid-1</guid>
    </item></channel></rss>`;
    const fetchImpl = vi.fn(async () => new Response(rssXml, { status: 200 }));

    await withConfiguredServer(config, { autoPrepare: false, fetchImpl }, async (app) => {
      const settings = await app.inject({ method: "PATCH", url: "/api/rss/settings", payload: { updateIntervalMs: 300000 } });
      expect(settings.statusCode).toBe(200);
      expect(settings.json()).toMatchObject({ settings: { updateIntervalMs: 300000 } });

      const created = await app.inject({
        method: "POST",
        url: "/api/rss/subscriptions",
        payload: {
          name: "ZMPT",
          site: "zmweb",
          feedUrl: "https://zmpt.cc/torrentrss.php?passkey=secret",
          enabled: true,
          filter: {}
        }
      });
      expect(created.statusCode).toBe(201);
      expect(JSON.stringify(created.json())).not.toContain("secret");
      const subscriptionId = created.json<{ subscription: { id: string } }>().subscription.id;

      const refresh = await app.inject({ method: "POST", url: `/api/rss/subscriptions/${subscriptionId}/refresh` });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.json()).toMatchObject({ result: { fetched: 1, proposals: 1 } });

      const proposals = await app.inject({ method: "GET", url: `/api/rss/subscriptions/${subscriptionId}/items?view=proposals` });
      expect(proposals.statusCode).toBe(200);
      expect(proposals.json()).toMatchObject({
        items: [
          {
            title: "Movie 2026 1080p WEB-DL x265-GROUP",
            status: "proposal",
            ptpTarget: { groupId: "123", ptpUrl: "https://passthepopcorn.me/torrents.php?id=123" }
          }
        ]
      });
      expect(JSON.stringify(proposals.json())).not.toContain("secret");
    });
  });

  it("does not refresh RSS feeds before manual refresh when auto preparation is disabled", async () => {
    const fetchImpl = vi.fn(async () => new Response("<rss><channel /></rss>", { status: 200 }));

    await withConfiguredServer(testConfig(), { autoPrepare: false, fetchImpl }, async (app) => {
      const created = await app.inject({
        method: "POST",
        url: "/api/rss/subscriptions",
        payload: { name: "ZMPT", site: "zmweb", feedUrl: "https://zmpt.cc/rss?passkey=secret", enabled: true, filter: {} }
      });
      expect(created.statusCode).toBe(201);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it("accepts a proposal and returns the created job", async () => {
    const config = testConfig();
    const rssXml = `<?xml version="1.0"?><rss><channel><item>
      <title><![CDATA[[电影 / Movies]Movie 2026 1080p WEB-DL x265-GROUP[中字][1 GB]]]></title>
      <link>https://zmpt.cc/details.php?id=1</link>
      <description><![CDATA[https://www.imdb.com/title/tt1234567/]]></description>
      <enclosure url="https://zmpt.cc/download.php?downhash=secret" length="1000" />
      <guid>guid-1</guid>
    </item></channel></rss>`;
    let servedTorrent = false;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.includes("download.php")) {
        servedTorrent = true;
        return new Response("d4:infod6:lengthi1eee", { status: 200, headers: { "content-type": "application/x-bittorrent" } });
      }
      return new Response(rssXml, { status: 200 });
    });
    vi.spyOn(PtpClient.prototype, "searchByCandidate").mockResolvedValue({
      movies: [{ GroupId: "123", Title: "Movie", Year: "2026", ImdbId: "tt1234567", Torrents: [] }]
    });

    await withConfiguredServer(config, { autoPrepare: false, fetchImpl }, async (app) => {
      const created = await app.inject({
        method: "POST",
        url: "/api/rss/subscriptions",
        payload: { name: "ZMPT", site: "zmweb", feedUrl: "https://zmpt.cc/rss?passkey=secret", enabled: true, filter: {} }
      });
      const subscriptionId = created.json<{ subscription: { id: string } }>().subscription.id;
      await app.inject({ method: "POST", url: `/api/rss/subscriptions/${subscriptionId}/refresh` });
      const proposals = await app.inject({ method: "GET", url: `/api/rss/subscriptions/${subscriptionId}/items?view=proposals` });
      const itemId = proposals.json<{ items: Array<{ id: string }> }>().items[0]!.id;

      const accept = await app.inject({ method: "POST", url: `/api/rss/items/${itemId}/accept` });

      expect(accept.statusCode).toBe(200);
      expect(accept.json()).toMatchObject({ item: { status: "accepted" }, job: { state: "preparing" } });
      expect(servedTorrent).toBe(true);
      expect(JSON.stringify(accept.json())).not.toContain("secret");
    });
  });
});
