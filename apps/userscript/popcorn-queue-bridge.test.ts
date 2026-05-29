import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const userscriptPath = fileURLToPath(new URL("./popcorn-queue-bridge.user.js", import.meta.url));

function userscriptMetadata(): string {
  const text = readFileSync(userscriptPath, "utf8");
  const match = text.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/);
  return match?.[0] ?? "";
}

function connectHosts(): string[] {
  return [...userscriptMetadata().matchAll(/^\/\/ @connect\s+(.+)$/gm)].map((match) => match[1].trim());
}

function userscriptText(): string {
  return readFileSync(userscriptPath, "utf8");
}

function userscriptInternals(overrides: Record<string, unknown> = {}) {
  const text = userscriptText().replace(
    "  registerSettings();",
    "  globalThis.__pqTest = { LOCAL_CACHE_TTL_MS, hasUnsupportedFrameRate, shouldOfferUpload, localCacheKey, localCacheStorageKey, localCacheSet, extractSourceSubtitle };\n  registerSettings();"
  );
  const sandbox = {
    GM_registerMenuCommand: () => undefined,
    GM_getValue: () => undefined,
    GM_setValue: () => undefined,
    window: { location: { hostname: "example.test" } },
    document: {},
    ...overrides
  };
  vm.createContext(sandbox);
  vm.runInContext(text, sandbox);
  return (sandbox as {
    __pqTest: {
      LOCAL_CACHE_TTL_MS: number;
      hasUnsupportedFrameRate(name: string): boolean;
      shouldOfferUpload(torrent: { title?: string }, status: string): boolean;
      localCacheKey(torrent: { title: string; imdbId?: string | null }): string;
      localCacheStorageKey(cacheKey: string): string;
      localCacheSet(torrent: { title: string; imdbId?: string | null }, result: { decision?: { status?: string }; cache?: { hit?: boolean; key?: string } }): void;
      extractSourceSubtitle(
        link: { closest(selector: string): unknown; textContent?: string | null },
        scope: { querySelector(selector: string): { textContent?: string | null } | null },
        title: string
      ): string | null;
    };
  }).__pqTest;
}

describe("Popcorn Queue userscript metadata", () => {
  it("keeps the committed userscript as a wildcard template", () => {
    expect(userscriptMetadata()).toMatch(/^\/\/ @connect\s+\*$/m);
  });

  it("does not commit concrete userscript connect hosts", () => {
    expect(connectHosts()).toEqual(["*"]);
  });

  it("does not expose runtime URL menu overrides", () => {
    const text = userscriptText();

    expect(text).not.toContain("Set Popcorn Queue API URL");
    expect(text).not.toContain("Set Popcorn Queue Web URL");
    expect(text).not.toContain("GM_setValue(\"serviceUrl\"");
    expect(text).not.toContain("GM_setValue(\"webUrl\"");
  });
});

describe("Popcorn Queue userscript checks", () => {
  it("rechecks only the right-clicked torrent", () => {
    const text = userscriptText();

    expect(text).toContain("await recheckTorrent(site, status, torrent);");
    expect(text).toContain('apiRequest("POST", "/api/browser/check"');
    expect(text).not.toContain("await runCheck(site, status, { bypassCache: true });");
  });

  it("keeps a 180 day local browser-check cache for page-load badges", () => {
    const internals = userscriptInternals();
    const text = userscriptText();

    expect(internals.LOCAL_CACHE_TTL_MS).toBe(180 * 24 * 60 * 60 * 1000);
    expect(internals.localCacheKey({ title: "Interstellar.2014.1080p.BluRay.x264-GROUP", imdbId: "https://www.imdb.com/title/tt0816692/" })).toBe(
      "ptp:imdb:tt0816692"
    );
    expect(internals.localCacheKey({ title: "Interstellar.2014.1080p.BluRay.x264-GROUP", imdbId: null })).toBe("ptp:search:interstellar|2014");
    expect(internals.localCacheStorageKey("ptp:imdb:tt0816692")).toBe("pq:browser-check:ptp:imdb:tt0816692");
    expect(text).toContain("renderCachedBadges(site, status);");
    expect(text).toContain("localCacheSet(torrent, result);");
  });

  it("does not persist uncached PTP error results in local browser-check cache", () => {
    const writes: Array<{ key: string; value: string }> = [];
    const internals = userscriptInternals({
      GM_setValue: (key: string, value: string) => writes.push({ key, value })
    });

    internals.localCacheSet(
      { title: "Interstellar.2014.1080p.BluRay.x264-GROUP", imdbId: "tt0816692" },
      { decision: { status: "error" }, cache: { hit: false, key: "ptp:imdb:tt0816692" } }
    );
    internals.localCacheSet(
      { title: "Interstellar.2014.1080p.BluRay.x264-GROUP", imdbId: "tt0816692" },
      { decision: { status: "open" }, cache: { hit: false, key: "ptp:imdb:tt0816692" } }
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBe("pq:browser-check:ptp:imdb:tt0816692");
  });

  it("extracts PTerClub subtitles from the sibling line span without including the release title", () => {
    const internals = userscriptInternals();
    const title = "Space Mutation 2026 1080p WEB-DL H264 AAC 2.0-ADWeb";
    const subtitle = "国语中字 太空异种 / 深空异客 | 类型：科幻 惊悚 冒险 | 主演：魏璐 林妍柔 柳扬 王铭 安泽豪 *银河奇异果";
    const subtitleSpan = { tagName: "SPAN", textContent: subtitle };
    const subtitleLine = {
      children: [{ tagName: "A", textContent: "国语" }, { tagName: "A", textContent: "中字" }, subtitleSpan],
      querySelector: (selector: string) => (selector === "span" ? subtitleSpan : null)
    };
    const titleLine = { nextElementSibling: subtitleLine };
    const link = {
      textContent: title,
      closest: (selector: string) => (selector === "div" ? titleLine : null)
    };

    expect(internals.extractSourceSubtitle(link, { querySelector: () => null }, title)).toBe(subtitle);
  });

  it("extracts TJUPT subtitles from text after the title break", () => {
    const internals = userscriptInternals();
    const title = "[大陆][遇见喵星人][The.Battle.of.Math.2021.1080p.WEB-DL.HEVC.HDR.AAC-SewageWeb]";
    const subtitle = "遇见喵星人 / The Battle of Math | 导演：王佳伟 / 主演：艾伦 / 王智 / 程旭 | 类型：剧情 / 喜剧 / 奇幻 | 汉语普通话";
    const link = { textContent: title, closest: (selector: string) => (selector === "td" ? titleCell : null) };
    const titleCell = {
      childNodes: [
        link,
        { nodeType: 1, tagName: "B", textContent: " (新)" },
        { nodeType: 1, tagName: "BR", textContent: "" },
        { nodeType: 3, textContent: subtitle }
      ]
    };

    expect(internals.extractSourceSubtitle(link, { querySelector: () => null }, title)).toBe(subtitle);
  });

  it("extracts HHClub subtitles from the explicit small-name field", () => {
    const internals = userscriptInternals();
    const title = "No Other Love 2026 2160p WEB-DL H265 HQ DTS5.1 3Audios-HHWEB";
    const subtitle = "蜂蜜的针 / 没有别的爱 | 4K 高码+多规格音轨 | 类型: 爱情/悬疑/犯罪 | 导演: 袁梅 | 主演: 袁泉/耿乐/宁静/俞飞鸿/齐溪";

    expect(
      internals.extractSourceSubtitle(
        { textContent: title, closest: () => null },
        { querySelector: (selector: string) => (selector.includes("torrent-info-text-small_name") ? { textContent: subtitle } : null) },
        title
      )
    ).toBe(subtitle);
  });
});

describe("Popcorn Queue userscript upload button", () => {
  it("supports right-click upload without opening Popcorn Queue", () => {
    const text = userscriptText();

    expect(text).toContain("Up without open popcorn queue");
    expect(text).toContain('button.addEventListener("contextmenu"');
    expect(text).toContain("await sendJob(torrent, result, button, badge, { openQueue: false });");
    expect(text).toContain("await sendJob(torrent, result, button, badge);");
    expect(text).toContain("if (options.openQueue !== false) window.open(jobUrl(response.job.id), \"_blank\");");
  });

  it("skips upload buttons for release names above 50 fps", () => {
    const internals = userscriptInternals();

    expect(internals.hasUnsupportedFrameRate("Bystander 2025 2160p WEB-DL 60Fps HDRVivid H.265 10bit AAC 2.0-UBWEB")).toBe(true);
    expect(internals.hasUnsupportedFrameRate("Movie 2025 1080p WEB-DL 59.94 FPS H.264-GROUP")).toBe(true);
    expect(internals.hasUnsupportedFrameRate("Movie 2025 1080p WEB-DL 50fps H.264-GROUP")).toBe(false);
    expect(internals.hasUnsupportedFrameRate("Movie 2025 2160p WEB-DL H.265 10bit AAC 2.0-GROUP")).toBe(false);
    expect(internals.shouldOfferUpload({ title: "Bystander 2025 2160p WEB-DL 60Fps HDRVivid H.265 10bit AAC 2.0-UBWEB" }, "open")).toBe(false);
    expect(internals.shouldOfferUpload({ title: "Movie 2025 2160p WEB-DL H.265 10bit AAC 2.0-GROUP" }, "open")).toBe(true);
  });
});
