import { describe, expect, it } from "vitest";
import {
  evaluateRssFilter,
  parseRssFeed,
  redactSecretUrl,
  rssItemStatusFromDecision,
  rssItemToTorrentCandidate,
  type RssFilterConfig
} from "./rss.js";

const zmptRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>织梦 Torrents</title>
    <item>
      <title><![CDATA[[电影 / Movies]Fat and Fame 2018 2160p EDR WEB-DL HEVC DDP5.1-ZmWeb[人怕出名猪怕壮 / Fat and Fame | 类型：喜剧][9.12 GB]]]></title>
      <link>https://zmpt.cc/details.php?id=473940</link>
      <description><![CDATA[
        <a href="https://www.imdb.com/title/tt1234567/">IMDb</a>
        <fieldset><legend> 引用 </legend>
Complete name : 人怕出名猪怕壮.Fat.and.Fame.2018.2160p.EDR.WEB-DL.HEVC.DDP5.1-ZmWeb.mp4
        </fieldset>
      ]]></description>
      <enclosure url="https://zmpt.cc/download.php?downhash=secret-token" length="9788381427" type="application/x-bittorrent" />
      <guid isPermaLink="false">2091c757a41e7f50f480325d9f082e49d1e5f769</guid>
      <pubDate>Fri, 22 May 2026 12:39:47 +0800</pubDate>
    </item>
  </channel>
</rss>`;

describe("RSS parsing", () => {
  it("extracts normalized torrent fields from a NexusPHP RSS item", () => {
    const feed = parseRssFeed(zmptRss, { site: "zmweb" });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      site: "zmweb",
      title: "Fat and Fame 2018 2160p EDR WEB-DL HEVC DDP5.1-ZmWeb",
      subtitle: "人怕出名猪怕壮 / Fat and Fame | 类型：喜剧",
      sourceUrl: "https://zmpt.cc/details.php?id=473940",
      downloadUrl: "https://zmpt.cc/download.php?downhash=secret-token",
      guid: "2091c757a41e7f50f480325d9f082e49d1e5f769",
      size: 9788381427,
      imdbId: "tt1234567"
    });
    expect(feed.items[0]?.publishedAt).toBe("2026-05-22T04:39:47.000Z");
  });

  it("creates TorrentCandidate input for duplicate check", () => {
    const item = parseRssFeed(zmptRss, { site: "zmweb" }).items[0]!;
    expect(rssItemToTorrentCandidate(item)).toMatchObject({
      site: "zmweb",
      title: "Fat and Fame 2018 2160p EDR WEB-DL HEVC DDP5.1-ZmWeb",
      subtitle: "人怕出名猪怕壮 / Fat and Fame | 类型：喜剧",
      imdbId: "tt1234567",
      sourceUrl: "https://zmpt.cc/details.php?id=473940",
      downloadUrl: "https://zmpt.cc/download.php?downhash=secret-token",
      sourceTorrentId: "473940"
    });
  });
});

describe("RSS filters", () => {
  it("filters by exclude keyword before duplicate checks", () => {
    const filter: RssFilterConfig = { excludeKeywords: ["60Fps"] };
    expect(evaluateRssFilter({ title: "Bystander.2025.2160p.WEB-DL.60Fps.HDR.x265-GROUP", size: 1 }, filter)).toEqual({
      passed: false,
      reason: "Title matched excluded keyword: 60Fps"
    });
  });

  it("passes when include, resolution, codec, group, and size rules match", () => {
    const filter: RssFilterConfig = {
      includeKeywords: ["WEB-DL"],
      allowedResolutions: ["2160p"],
      allowedCodecs: ["x265"],
      blockedGroups: ["HDSWEB"],
      minSize: 1_000,
      maxSize: 10_000
    };
    expect(evaluateRssFilter({ title: "Movie.2026.2160p.WEB-DL.x265-GROUP", size: 5_000 }, filter)).toEqual({
      passed: true,
      reason: null
    });
  });
});

describe("RSS duplicate status mapping", () => {
  it.each([
    ["open", "proposal"],
    ["not_found", "proposal"],
    ["no_torrents", "proposal"],
    ["coexist", "proposal"],
    ["trumpable", "proposal"],
    ["full", "duplicate_full"],
    ["skip", "duplicate_skip"],
    ["error", "check_error"],
    ["review", "duplicate_skip"]
  ] as const)("maps %s to %s", (decisionStatus, itemStatus) => {
    expect(rssItemStatusFromDecision(decisionStatus)).toBe(itemStatus);
  });
});

describe("RSS URL redaction", () => {
  it("redacts secret-bearing query values without hiding the source host", () => {
    expect(redactSecretUrl("https://zmpt.cc/torrentrss.php?passkey=abc&rows=10&downhash=def")).toBe(
      "https://zmpt.cc/torrentrss.php?passkey=%5Bredacted%5D&rows=10&downhash=%5Bredacted%5D"
    );
  });
});
